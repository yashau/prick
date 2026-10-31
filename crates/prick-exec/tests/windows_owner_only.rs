//! Windows-only behaviour: a file created owner-only in a directory whose ACL
//! lets other accounts in.
//!
//! The directory is made deliberately permissive -- `Everyone` granted read,
//! inheritable onto every file created in it -- because that is the case the
//! creation-time descriptor exists for. A file written there the ordinary way
//! inherits the grant; one made by `create_owner_only_file` must carry the
//! current user's entry and nothing else, protected, from its first instant.

#![cfg(windows)]

use std::io::{Read as _, Write as _};
use std::path::Path;
use std::process::Command;

use prick_exec::winsec::{
    create_owner_only_file, current_user_sid_string, dacl_sddl, is_restricted_to_current_user,
};

/// Grants `Everyone` (S-1-1-0) read on `dir`, inherited by files and
/// subdirectories created in it.
fn grant_everyone_read(dir: &Path) {
    let status = Command::new("icacls")
        .arg(dir)
        .args(["/grant", "*S-1-1-0:(OI)(CI)(R)"])
        .output()
        .expect("icacls runs");
    assert!(status.status.success(), "icacls failed: {status:?}");
}

/// A temporary directory whose new files inherit an `Everyone` read entry.
fn permissive_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("a temporary directory");
    grant_everyone_read(dir.path());

    // The control: an ordinarily created file does inherit the grant, so the
    // directory really is the hazard this test is about.
    let control = dir.path().join("control");
    std::fs::write(&control, b"x").expect("write");
    let sddl = dacl_sddl(&control).expect("the control's DACL");
    assert!(sddl.contains(";WD)"), "Everyone was not inherited by the control: {sddl}");
    assert!(sddl.contains("ID;"), "the control carries no inherited entry: {sddl}");
    std::fs::remove_file(&control).expect("remove the control");

    dir
}

#[test]
fn a_file_is_born_owner_only_in_a_directory_that_grants_everyone_read() {
    let dir = permissive_dir();
    let path = dir.path().join(".secret.tmp");

    let mut file = create_owner_only_file(&path).expect("created");
    // Checked while the handle is still open, before anything is written: the
    // DACL is right from creation, not fixed up afterwards.
    let sddl = dacl_sddl(&path).expect("the new file's DACL");
    let sid = current_user_sid_string().expect("the process has a user");
    assert_eq!(sddl, format!("D:P(A;;FA;;;{sid})"), "the DACL is exactly the owner, protected");
    assert!(!sddl.contains("ID;"), "an inherited entry survived: {sddl}");
    assert!(!sddl.contains("WD"), "Everyone can read the file: {sddl}");

    file.write_all(b"value").expect("the owner can write");
    file.sync_all().expect("and flush");
    drop(file);

    assert!(is_restricted_to_current_user(&path).expect("readable DACL"));
    let mut read_back = String::new();
    std::fs::File::open(&path)
        .and_then(|mut file| file.read_to_string(&mut read_back))
        .expect("the owner can read it back");
    assert_eq!(read_back, "value");
}

#[test]
fn an_existing_file_is_refused_rather_than_opened() {
    let dir = permissive_dir();
    let planted = dir.path().join("planted");
    std::fs::write(&planted, b"someone else's").expect("plant a file");

    let err = create_owner_only_file(&planted).expect_err("an existing path is never opened");
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists, "{err}");
    assert_eq!(std::fs::read(&planted).expect("readable"), b"someone else's");
}
