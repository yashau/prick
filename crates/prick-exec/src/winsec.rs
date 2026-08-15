//! Restricting a file or directory to the current user on Windows.
//!
//! # Why this lives in `prick-exec`
//!
//! It is used by `prick-auth`, to protect the token file. It lives here because
//! this crate is the workspace's single home for `unsafe`, and there is no way
//! to reach the Windows security APIs without it. The alternative -- a second
//! crate with a second `unsafe` allowance -- would trade a slightly odd module
//! boundary for a genuinely worse invariant.
//!
//! # What Windows does instead of `0600`
//!
//! There is no mode. A new file inherits its parent directory's ACL, and the
//! parent is usually somewhere under the user's profile whose ACL already
//! grants `SYSTEM` and `Administrators` full control. That is not the same as
//! owner-only, and on a shared or domain-joined machine it is not close.
//!
//! So the DACL is replaced outright with a single access-allowed entry for the
//! current user, and marked **protected**, which stops the parent's entries
//! being re-merged in on the next inheritance propagation.
//! `PROTECTED_DACL_SECURITY_INFORMATION` is the flag that does that; without
//! it, the restriction quietly reverts.
//!
//! # Why SDDL rather than hand-built ACLs
//!
//! Building an `ACL` by hand means `InitializeAcl`, `AddAccessAllowedAce`, a
//! correctly sized allocation, and getting the ACE alignment right.
//! `ConvertStringSecurityDescriptorToSecurityDescriptorW` does all of that from
//! `D:P(A;;FA;;;<sid>)`, and the string is reviewable at a glance.

use std::ffi::{OsStr, c_void};
use std::io;
use std::os::windows::ffi::OsStrExt as _;
use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, FALSE, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION,
    EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorDacl,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Whether the entry should propagate to things created inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inheritance {
    /// Applies to this object only. Used for the token file itself.
    ObjectOnly,
    /// Propagates to files and subdirectories. Used for the parent directory,
    /// so a file created later starts out restricted rather than being fixed
    /// up afterwards.
    Propagating,
}

impl Inheritance {
    /// The SDDL ACE flags for this mode.
    fn ace_flags(self) -> &'static str {
        match self {
            Self::ObjectOnly => "",
            // OI: object inherit. CI: container inherit.
            Self::Propagating => "OICI",
        }
    }
}

/// A `LocalAlloc`-owned pointer, freed on drop.
///
/// Several of these APIs allocate their out-parameters with `LocalAlloc` and
/// document the caller as responsible for `LocalFree`. Wrapping it means the
/// early returns below cannot leak.
#[derive(Debug)]
struct LocalPtr(*mut c_void);

impl Drop for LocalPtr {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from a Win32 call documented as
            // allocating with `LocalAlloc`, has not been freed (this is the
            // only place that frees it, and `LocalPtr` is not `Clone`), and is
            // checked for null.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

/// A process token handle, closed on drop.
#[derive(Debug)]
struct TokenHandle(HANDLE);

impl Drop for TokenHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: opened by `OpenProcessToken` below and closed exactly
            // once, because `TokenHandle` is not `Clone` and does not hand out
            // the raw handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Encodes a path as a NUL-terminated wide string.
fn wide(path: &OsStr) -> Vec<u16> {
    path.encode_wide().chain(std::iter::once(0)).collect()
}

/// Reads the current process's user SID into a caller-owned buffer.
///
/// Returns the buffer; the SID it contains points into it, so the buffer must
/// outlive every use of the SID.
///
/// The element type is `u64` rather than `u8` so the allocation is 8-byte
/// aligned. `TOKEN_USER` contains a pointer, and reading one through an
/// under-aligned reference is undefined behaviour even on x86, where the
/// hardware would tolerate it.
fn current_user_sid_buffer() -> io::Result<Vec<u64>> {
    let mut raw_token: HANDLE = std::ptr::null_mut();

    // SAFETY: `GetCurrentProcess` returns a pseudo-handle that needs no
    // closing. `raw_token` is a live local the call writes through, and its
    // value is immediately wrapped in `TokenHandle` so it is closed on every
    // path out of this function.
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut raw_token) };
    if ok == FALSE {
        return Err(io::Error::last_os_error());
    }
    let token = TokenHandle(raw_token);

    let mut needed: u32 = 0;
    // SAFETY: a deliberate zero-length probe. Passing a null buffer with length
    // zero is the documented way to ask for the required size; the call is
    // expected to fail with ERROR_INSUFFICIENT_BUFFER and write `needed`. The
    // return value is therefore ignored and `needed` is what is checked.
    unsafe {
        windows_sys::Win32::Security::GetTokenInformation(
            token.0,
            TokenUser,
            std::ptr::null_mut(),
            0,
            &raw mut needed,
        );
    }
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }

    let words = (needed as usize).div_ceil(size_of::<u64>());
    let mut buffer = vec![0u64; words];
    // SAFETY: `buffer` is at least `needed` bytes long -- it is rounded up to a
    // whole number of 8-byte words -- and it is alive for the duration of the
    // call. The information class matches the `TOKEN_USER` layout the caller
    // then reads.
    let ok = unsafe {
        windows_sys::Win32::Security::GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &raw mut needed,
        )
    };
    if ok == FALSE {
        return Err(io::Error::last_os_error());
    }

    Ok(buffer)
}

/// Reads the `SID` out of a buffer filled by [`current_user_sid_buffer`].
///
/// # Safety
///
/// `buffer` must have been produced by [`current_user_sid_buffer`] and must
/// outlive the returned pointer.
unsafe fn sid_from_buffer(buffer: &[u64]) -> PSID {
    // SAFETY: the buffer was sized by the API itself for a `TOKEN_USER` and is
    // a `u64` allocation, so it is both large enough and aligned for one. The
    // `Sid` field points into the same allocation.
    let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    token_user.User.Sid
}

/// The current user's SID in string form, for an SDDL descriptor.
fn current_user_sid_string() -> io::Result<String> {
    let buffer = current_user_sid_buffer()?;
    // SAFETY: `buffer` was produced by `current_user_sid_buffer` and outlives
    // `sid`, which is used only within this function.
    let sid = unsafe { sid_from_buffer(&buffer) };

    let mut raw: *mut u16 = std::ptr::null_mut();
    // SAFETY: `sid` is a valid SID pointing into `buffer`, which is still
    // alive. The out-parameter is a live local, and its value is wrapped in
    // `LocalPtr` immediately so the allocation is freed on every path.
    let ok = unsafe { ConvertSidToStringSidW(sid, &raw mut raw) };
    if ok == FALSE {
        return Err(io::Error::last_os_error());
    }
    let owned = LocalPtr(raw.cast());

    // SAFETY: on success the API returns a NUL-terminated wide string, so
    // scanning for the terminator is bounded by the allocation.
    let text = unsafe {
        let mut len = 0usize;
        while *raw.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(raw, len))
    };
    drop(owned);

    Ok(text)
}

/// Replaces a path's DACL with a single entry for the current user.
///
/// The DACL is marked protected, so the parent directory's entries are not
/// merged back in later.
///
/// # Errors
///
/// Whatever the underlying Windows security API reported. A path that does not
/// exist produces `ERROR_FILE_NOT_FOUND`.
pub fn restrict_to_current_user(path: &Path, inheritance: Inheritance) -> io::Result<()> {
    let sid = current_user_sid_string()?;
    // D  : a discretionary ACL follows
    // P  : protected -- do not inherit entries from the parent
    // A  : access allowed
    // FA : file all access
    let sddl = format!("D:P(A;{};FA;;;{sid})", inheritance.ace_flags());
    let sddl_wide = wide(OsStr::new(&sddl));

    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: `sddl_wide` is NUL-terminated and alive across the call. The
    // out-parameter is a live local whose value is wrapped in `LocalPtr`
    // immediately, and the final argument is null, which the API documents as
    // "do not report the descriptor's size".
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            SDDL_REVISION_1,
            &raw mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if ok == FALSE {
        return Err(io::Error::last_os_error());
    }
    let owned = LocalPtr(descriptor.cast());

    let mut present: i32 = 0;
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut defaulted: i32 = 0;
    // SAFETY: `descriptor` is a valid security descriptor owned by `owned` and
    // alive for the call. All three out-parameters are live locals. The `dacl`
    // it yields points into `descriptor` and is used only while `owned` is
    // still alive.
    let ok = unsafe {
        GetSecurityDescriptorDacl(descriptor, &raw mut present, &raw mut dacl, &raw mut defaulted)
    };
    if ok == FALSE {
        return Err(io::Error::last_os_error());
    }
    if present == FALSE || dacl.is_null() {
        return Err(io::Error::other(
            "the generated security descriptor has no access control list",
        ));
    }

    let mut object = wide(path.as_os_str());
    // SAFETY: `object` is a NUL-terminated wide path alive for the call.
    // `dacl` points into `descriptor`, which `owned` keeps alive past this
    // point. The owner, group and SACL arguments are null, which the API
    // documents as "leave unchanged", and the information flags say so too.
    let status = unsafe {
        SetNamedSecurityInfoW(
            object.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null_mut(),
        )
    };
    drop(owned);

    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(i32::try_from(status).unwrap_or(i32::MAX)));
    }
    Ok(())
}

/// Whether a path's DACL grants access to nobody but the current user.
///
/// This is what `prk doctor` reports. A `false` here is the Windows equivalent
/// of finding a token file at mode `0644`.
///
/// # Errors
///
/// Whatever the underlying Windows security API reported.
pub fn is_restricted_to_current_user(path: &Path) -> io::Result<bool> {
    let sid_buffer = current_user_sid_buffer()?;
    // SAFETY: `sid_buffer` was produced by `current_user_sid_buffer` and
    // outlives every use of `expected` below.
    let expected = unsafe { sid_from_buffer(&sid_buffer) };

    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let mut object = wide(path.as_os_str());

    // SAFETY: `object` is a NUL-terminated wide path alive for the call. The
    // owner, group and SACL out-parameters are null, which the API documents as
    // "not requested", matching the information flags. On success `descriptor`
    // is a `LocalAlloc` allocation the caller must free, which `LocalPtr` does.
    let status = unsafe {
        GetNamedSecurityInfoW(
            object.as_mut_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &raw mut dacl,
            std::ptr::null_mut(),
            &raw mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(i32::try_from(status).unwrap_or(i32::MAX)));
    }
    let _owned = LocalPtr(descriptor.cast());

    // A null DACL is not "no access"; it is "access to everyone".
    if dacl.is_null() {
        return Ok(false);
    }

    // SAFETY: `dacl` points into `descriptor`, which `_owned` keeps alive. The
    // information class matches the `ACL_SIZE_INFORMATION` layout, and the size
    // passed is that struct's exact size.
    let mut info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    let size = u32::try_from(size_of::<ACL_SIZE_INFORMATION>())
        .map_err(|_| io::Error::other("access control list size structure is implausibly large"))?;
    // SAFETY: as above; `info` is a live local of the matching type.
    let ok = unsafe { GetAclInformation(dacl, (&raw mut info).cast(), size, AclSizeInformation) };
    if ok == FALSE {
        return Err(io::Error::last_os_error());
    }

    // An empty DACL denies everyone, including us. That is not what this
    // function is asked about, and it is not a state the writer produces.
    if info.AceCount == 0 {
        return Ok(false);
    }

    for index in 0..info.AceCount {
        let mut ace: *mut c_void = std::ptr::null_mut();
        // SAFETY: `index` is below `AceCount`, which the API just reported, and
        // `dacl` is still alive.
        let ok = unsafe { GetAce(dacl, index, &raw mut ace) };
        if ok == FALSE {
            return Err(io::Error::last_os_error());
        }

        // SAFETY: every ACE type this can return begins with an `ACE_HEADER`
        // followed by a mask and an inline SID, which is the prefix of
        // `ACCESS_ALLOWED_ACE`. Only the header and the address of `SidStart`
        // are read, both of which are in that common prefix.
        let sid = unsafe {
            let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            (&raw const ace.SidStart).cast::<c_void>().cast_mut()
        };

        // SAFETY: `sid` points into the ACE, which points into `descriptor`,
        // and `expected` points into `sid_buffer`. Both are alive here.
        let same = unsafe { EqualSid(sid, expected) };
        if same == FALSE {
            return Ok(false);
        }
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_current_user_has_a_readable_sid() {
        let sid = current_user_sid_string().expect("the process has a user");
        assert!(sid.starts_with("S-1-"), "not a SID: {sid}");
    }

    #[test]
    fn the_sddl_says_protected_and_full_access() {
        let sid = current_user_sid_string().expect("the process has a user");
        let sddl = format!("D:P(A;{};FA;;;{sid})", Inheritance::ObjectOnly.ace_flags());
        assert!(sddl.starts_with("D:P("), "the DACL must be protected: {sddl}");
        assert!(sddl.contains(";FA;"));
        assert!(sddl.contains(&sid));
    }

    #[test]
    fn a_directory_entry_propagates_and_a_file_entry_does_not() {
        assert_eq!(Inheritance::ObjectOnly.ace_flags(), "");
        assert_eq!(Inheritance::Propagating.ace_flags(), "OICI");
    }

    #[test]
    fn a_restricted_file_verifies_and_an_untouched_one_does_not() {
        let dir = tempfile::tempdir().expect("a temporary directory");

        let loose = dir.path().join("loose.json");
        std::fs::write(&loose, b"{}").expect("write");
        // Inherits the temporary directory's ACL, which grants at least SYSTEM
        // and Administrators, so this must not read as owner-only.
        assert!(
            !is_restricted_to_current_user(&loose).expect("reading the DACL must succeed"),
            "an inherited DACL was wrongly reported as owner-only"
        );

        let tight = dir.path().join("tight.json");
        std::fs::write(&tight, b"{}").expect("write");
        restrict_to_current_user(&tight, Inheritance::ObjectOnly)
            .expect("restricting must succeed");
        assert!(
            is_restricted_to_current_user(&tight).expect("reading the DACL must succeed"),
            "a restricted file was not recognised as owner-only"
        );
    }

    #[test]
    fn restricting_a_missing_path_is_an_error_rather_than_a_silent_success() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let missing = dir.path().join("does-not-exist");
        assert!(restrict_to_current_user(&missing, Inheritance::ObjectOnly).is_err());
    }

    #[test]
    fn a_restricted_directory_still_accepts_new_files() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let inner = dir.path().join("store");
        std::fs::create_dir(&inner).expect("create");
        restrict_to_current_user(&inner, Inheritance::Propagating).expect("restrict");

        let file = inner.join("tokens.json");
        std::fs::write(&file, b"{}").expect("the owner must still be able to write");
        assert!(is_restricted_to_current_user(&inner).expect("read"));
    }
}
