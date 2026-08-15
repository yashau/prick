//! `CalVer` versions of the form `YYYY.MMDD.N`.
//!
//! # The two representations
//!
//! | Form | Example | Used by |
//! |---|---|---|
//! | Storage | `2026.815.0` | `Cargo.toml`, `package.json`, git tags, `prk --version` |
//! | Human | `2026.08.15.0` | Changelogs, release notes, UI |
//!
//! The storage form is the canonical one and is valid semver, which is why the
//! middle component carries **no leading zero**: `0105` is not a legal semver
//! numeric identifier, so January 5th is `105` and October 1st is `1001`.
//!
//! That encoding is monotonic within a year purely as integers --
//! `101 < 930 < 1001 < 1231` -- so semver's numeric comparison already orders
//! releases correctly and no special-casing is needed anywhere downstream.
//!
//! `N` is zero-based and counts releases already made on that date, so the
//! first release of a day is `.0`. Dates are **UTC**; computing locally east of
//! Greenwich produces a version a day ahead of CI.
//!
//! This module only parses, formats and compares. Deciding *today's* date needs
//! a clock, which this crate does not have; that lives in `scripts/version.mjs`.

use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

/// Reasons a `CalVer` string could not be parsed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum ParseCalVerError {
    /// The input did not have the expected number of dot-separated components.
    #[error("expected {expected} dot-separated components, found {found}")]
    ComponentCount {
        /// How many components the form being parsed requires.
        expected: usize,
        /// How many the input actually had.
        found: usize,
    },
    /// A component was empty, over-long, or contained a non-ASCII-digit.
    #[error("component `{component}` must be {expected}")]
    NotANumber {
        /// Which component failed, by name.
        component: &'static str,
        /// What was required of it.
        expected: &'static str,
    },
    /// A numeric component had a leading zero, which semver forbids.
    #[error("component `{component}` must not have a leading zero (January 5th is `105`)")]
    LeadingZero {
        /// Which component failed, by name.
        component: &'static str,
    },
    /// The month was outside 1..=12.
    #[error("month {month} is not in 1..=12")]
    InvalidMonth {
        /// The month that was parsed out of `MMDD`.
        month: u32,
    },
    /// The day was outside the valid range for that month and year.
    #[error("{year}-{month:02} has no day {day}")]
    InvalidDay {
        /// The year, needed because February varies.
        year: u16,
        /// The month.
        month: u8,
        /// The day that was parsed out of `MMDD`.
        day: u32,
    },
}

/// A `YYYY.MMDD.N` calendar version.
///
/// [`Ord`] compares year, then month, then day, then `N` -- release order. It
/// is written out rather than derived so that adding a field later cannot
/// silently change the comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CalVer {
    year: u16,
    month: u8,
    day: u8,
    n: u32,
}

impl CalVer {
    /// Builds a version from its components, validating the calendar date.
    ///
    /// # Errors
    ///
    /// Returns [`ParseCalVerError::InvalidMonth`] or
    /// [`ParseCalVerError::InvalidDay`] if the date does not exist. February
    /// 29th is accepted only in leap years.
    pub fn new(year: u16, month: u8, day: u8, n: u32) -> Result<Self, ParseCalVerError> {
        if !(1..=12).contains(&month) {
            return Err(ParseCalVerError::InvalidMonth { month: u32::from(month) });
        }
        if day < 1 || day > days_in_month(year, month) {
            return Err(ParseCalVerError::InvalidDay { year, month, day: u32::from(day) });
        }
        Ok(Self { year, month, day, n })
    }

    /// Parses the storage form, `YYYY.MMDD.N` (for example `2026.815.0`).
    ///
    /// # Errors
    ///
    /// Fails on the wrong component count, non-numeric or leading-zero
    /// components, or a date that does not exist.
    pub fn parse(raw: &str) -> Result<Self, ParseCalVerError> {
        let parts: Vec<&str> = raw.split('.').collect();
        if parts.len() != 3 {
            return Err(ParseCalVerError::ComponentCount { expected: 3, found: parts.len() });
        }

        let year = parse_year(parts[0])?;

        // MMDD is 3 digits for January-September and 4 for October-December.
        // Leading zeros are rejected here rather than silently accepted,
        // because `2026.0815.0` is not valid semver and would drift the moment
        // anything downstream normalised it.
        let mmdd = parse_component(parts[1], "MMDD", "3 or 4 digits")?;
        if parts[1].len() < 3 || parts[1].len() > 4 {
            return Err(ParseCalVerError::NotANumber {
                component: "MMDD",
                expected: "3 or 4 digits",
            });
        }

        let n = parse_component(parts[2], "N", "digits")?;

        let month = u8::try_from(mmdd / 100)
            .map_err(|_| ParseCalVerError::InvalidMonth { month: mmdd / 100 })?;
        let day = u8::try_from(mmdd % 100).map_err(|_| ParseCalVerError::InvalidDay {
            year,
            month,
            day: mmdd % 100,
        })?;

        Self::new(year, month, day, n)
    }

    /// Parses the human form, `YYYY.MM.DD.N` (for example `2026.08.15.0`).
    ///
    /// Here the month and day are **exactly two digits each**, zero-padded,
    /// because this form is never fed to a semver parser.
    ///
    /// # Errors
    ///
    /// Fails on the wrong component count, components that are not exactly two
    /// digits, or a date that does not exist.
    pub fn parse_human(raw: &str) -> Result<Self, ParseCalVerError> {
        let parts: Vec<&str> = raw.split('.').collect();
        if parts.len() != 4 {
            return Err(ParseCalVerError::ComponentCount { expected: 4, found: parts.len() });
        }

        let year = parse_year(parts[0])?;

        if parts[1].len() != 2 {
            return Err(ParseCalVerError::NotANumber {
                component: "MM",
                expected: "exactly 2 digits",
            });
        }
        if parts[2].len() != 2 {
            return Err(ParseCalVerError::NotANumber {
                component: "DD",
                expected: "exactly 2 digits",
            });
        }

        let month = parse_padded(parts[1], "MM")?;
        let day = parse_padded(parts[2], "DD")?;
        let n = parse_component(parts[3], "N", "digits")?;

        let month = u8::try_from(month).map_err(|_| ParseCalVerError::InvalidMonth { month })?;
        let day =
            u8::try_from(day).map_err(|_| ParseCalVerError::InvalidDay { year, month, day })?;

        Self::new(year, month, day, n)
    }

    /// The four-digit year.
    pub fn year(&self) -> u16 {
        self.year
    }

    /// The month, 1..=12.
    pub fn month(&self) -> u8 {
        self.month
    }

    /// The day of the month, 1..=31.
    pub fn day(&self) -> u8 {
        self.day
    }

    /// The zero-based release counter for that date.
    pub fn n(&self) -> u32 {
        self.n
    }

    /// The combined `MMDD` value used in the storage form.
    ///
    /// `105` for January 5th, `1001` for October 1st.
    pub fn mmdd(&self) -> u16 {
        u16::from(self.month) * 100 + u16::from(self.day)
    }

    /// Renders the human form, `YYYY.MM.DD.N`.
    pub fn to_human(&self) -> String {
        format!("{:04}.{:02}.{:02}.{}", self.year, self.month, self.day, self.n)
    }

    /// The next release on the same date, `N + 1`.
    ///
    /// Returns `None` if `N` would overflow, which is not a situation with a
    /// sensible recovery.
    pub fn next_on_same_day(&self) -> Option<Self> {
        Some(Self { n: self.n.checked_add(1)?, ..*self })
    }

    /// Whether two versions were released on the same calendar day.
    pub fn same_day(&self, other: &Self) -> bool {
        (self.year, self.month, self.day) == (other.year, other.month, other.day)
    }
}

impl fmt::Display for CalVer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.year, self.mmdd(), self.n)
    }
}

impl Ord for CalVer {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.year, self.month, self.day, self.n).cmp(&(
            other.year,
            other.month,
            other.day,
            other.n,
        ))
    }
}

impl PartialOrd for CalVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl FromStr for CalVer {
    type Err = ParseCalVerError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl TryFrom<String> for CalVer {
    type Error = ParseCalVerError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<CalVer> for String {
    fn from(value: CalVer) -> Self {
        value.to_string()
    }
}

/// Parses a component that must be all ASCII digits with no leading zero,
/// except for a bare `"0"`.
fn parse_component(
    raw: &str,
    component: &'static str,
    expected: &'static str,
) -> Result<u32, ParseCalVerError> {
    if raw.is_empty() || raw.len() > 9 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ParseCalVerError::NotANumber { component, expected });
    }
    if raw.len() > 1 && raw.starts_with('0') {
        return Err(ParseCalVerError::LeadingZero { component });
    }
    raw.parse().map_err(|_| ParseCalVerError::NotANumber { component, expected })
}

/// Parses a zero-padded fixed-width component from the human form, where a
/// leading zero is required rather than forbidden.
fn parse_padded(raw: &str, component: &'static str) -> Result<u32, ParseCalVerError> {
    if !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ParseCalVerError::NotANumber { component, expected: "digits" });
    }
    raw.parse().map_err(|_| ParseCalVerError::NotANumber { component, expected: "digits" })
}

/// Parses the year, which is always exactly four digits in both forms.
fn parse_year(raw: &str) -> Result<u16, ParseCalVerError> {
    if raw.len() != 4 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ParseCalVerError::NotANumber {
            component: "YYYY",
            expected: "exactly 4 digits",
        });
    }
    raw.parse().map_err(|_| ParseCalVerError::NotANumber {
        component: "YYYY",
        expected: "exactly 4 digits",
    })
}

/// Whether `year` is a leap year in the proleptic Gregorian calendar.
fn is_leap_year(year: u16) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

/// The number of days in `month` of `year`. Returns 0 for an invalid month so
/// that the caller's `day > days_in_month` check rejects it.
fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn january_boundary_has_three_digits_and_no_leading_zero() {
        let v = CalVer::parse("2026.105.0").unwrap();
        assert_eq!((v.year(), v.month(), v.day(), v.n()), (2026, 1, 5, 0));
        assert_eq!(v.mmdd(), 105);
        assert_eq!(v.to_string(), "2026.105.0");
        assert_eq!(v.to_human(), "2026.01.05.0");
    }

    #[test]
    fn january_first_is_101() {
        let v = CalVer::new(2026, 1, 1, 0).unwrap();
        assert_eq!(v.to_string(), "2026.101.0");
        assert_eq!(v.to_human(), "2026.01.01.0");
    }

    #[test]
    fn october_boundary_has_four_digits() {
        let v = CalVer::parse("2026.1001.3").unwrap();
        assert_eq!((v.year(), v.month(), v.day(), v.n()), (2026, 10, 1, 3));
        assert_eq!(v.mmdd(), 1001);
        assert_eq!(v.to_string(), "2026.1001.3");
        assert_eq!(v.to_human(), "2026.10.01.3");
    }

    #[test]
    fn september_to_october_crosses_the_digit_width_boundary() {
        let sep = CalVer::parse("2026.930.0").unwrap();
        let oct = CalVer::parse("2026.1001.0").unwrap();
        assert_eq!(sep.to_string().len(), "2026.930.0".len());
        assert_eq!(oct.to_string().len(), "2026.1001.0".len());
        assert!(sep < oct, "September must sort before October despite being shorter");
    }

    #[test]
    fn ordering_is_monotonic_across_the_year() {
        let versions: Vec<CalVer> = ["2026.101.0", "2026.930.0", "2026.1001.0", "2026.1231.0"]
            .iter()
            .map(|s| CalVer::parse(s).unwrap())
            .collect();

        for pair in versions.windows(2) {
            assert!(pair[0] < pair[1], "{} should sort before {}", pair[0], pair[1]);
        }

        let mut shuffled = vec![versions[3], versions[0], versions[2], versions[1]];
        shuffled.sort();
        assert_eq!(shuffled, versions);
    }

    #[test]
    fn mmdd_integer_ordering_matches_calendar_ordering() {
        // The property the whole encoding rests on.
        let mut previous = 0;
        for (month, day) in [(1, 1), (1, 5), (9, 30), (10, 1), (12, 31)] {
            let v = CalVer::new(2026, month, day, 0).unwrap();
            assert!(v.mmdd() > previous, "{} did not increase", v.mmdd());
            previous = v.mmdd();
        }
    }

    #[test]
    fn n_orders_within_a_day() {
        let a = CalVer::parse("2026.815.0").unwrap();
        let b = CalVer::parse("2026.815.1").unwrap();
        let c = CalVer::parse("2026.815.10").unwrap();
        assert!(a < b && b < c);
        assert!(a.same_day(&c));
        assert_eq!(a.next_on_same_day().unwrap(), b);
    }

    #[test]
    fn year_dominates_the_date() {
        let a = CalVer::parse("2026.1231.9").unwrap();
        let b = CalVer::parse("2027.101.0").unwrap();
        assert!(a < b);
        assert!(!a.same_day(&b));
    }

    #[test]
    fn human_form_round_trips_both_boundaries() {
        for storage in ["2026.105.0", "2026.1001.3", "2026.815.0", "2026.1231.12"] {
            let v = CalVer::parse(storage).unwrap();
            let human = v.to_human();
            assert_eq!(CalVer::parse_human(&human).unwrap(), v, "via {human}");
            assert_eq!(CalVer::parse_human(&human).unwrap().to_string(), storage);
        }
    }

    #[test]
    fn human_form_requires_zero_padding() {
        assert_eq!(
            CalVer::parse_human("2026.01.05.0").unwrap(),
            CalVer::new(2026, 1, 5, 0).unwrap()
        );
        assert!(CalVer::parse_human("2026.1.5.0").is_err());
        assert!(CalVer::parse_human("2026.010.05.0").is_err());
    }

    #[test]
    fn storage_form_rejects_leading_zeros() {
        // `2026.0105.0` is not valid semver, so it must never parse.
        assert_eq!(
            CalVer::parse("2026.0105.0"),
            Err(ParseCalVerError::LeadingZero { component: "MMDD" })
        );
        assert_eq!(
            CalVer::parse("2026.815.00"),
            Err(ParseCalVerError::LeadingZero { component: "N" })
        );
        assert_eq!(CalVer::parse("2026.815.0"), CalVer::new(2026, 8, 15, 0));
    }

    #[test]
    fn storage_form_rejects_wrong_mmdd_width() {
        assert!(CalVer::parse("2026.15.0").is_err());
        assert!(CalVer::parse("2026.10015.0").is_err());
    }

    #[test]
    fn rejects_impossible_dates() {
        assert_eq!(CalVer::parse("2026.1301.0"), Err(ParseCalVerError::InvalidMonth { month: 13 }));
        assert!(CalVer::parse("2026.001.0").is_err());
        assert_eq!(
            CalVer::parse("2026.229.0"),
            Err(ParseCalVerError::InvalidDay { year: 2026, month: 2, day: 29 })
        );
        assert!(CalVer::parse("2024.229.0").is_ok(), "2024 is a leap year");
        assert!(CalVer::parse("2000.229.0").is_ok(), "2000 is a leap year");
        assert!(CalVer::parse("1900.229.0").is_err(), "1900 is not a leap year");
        assert!(CalVer::parse("2026.431.0").is_err(), "April has 30 days");
        assert!(CalVer::parse("2026.430.0").is_ok());
    }

    #[test]
    fn rejects_malformed_input() {
        assert!(CalVer::parse("2026.815").is_err());
        assert!(CalVer::parse("2026.815.0.1").is_err());
        assert!(CalVer::parse("").is_err());
        assert!(CalVer::parse("v2026.815.0").is_err());
        assert!(CalVer::parse("2026.815.0-dev").is_err());
        assert!(CalVer::parse("26.815.0").is_err());
        assert!(CalVer::parse("2026.-15.0").is_err());
        assert!(CalVer::parse("0.0.0").is_err());
    }

    #[test]
    fn the_in_repo_placeholder_is_not_a_calver() {
        // Everything in the tree reads 0.0.0-dev until the tag is stamped in.
        assert!(CalVer::parse("0.0.0-dev").is_err());
    }

    #[test]
    fn serde_round_trips_through_the_storage_form() {
        let v = CalVer::parse("2026.105.0").unwrap();
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(json, r#""2026.105.0""#);
        assert_eq!(serde_json::from_str::<CalVer>(&json).unwrap(), v);
    }

    #[test]
    fn from_str_matches_parse() {
        let v: CalVer = "2026.1001.0".parse().unwrap();
        assert_eq!(v, CalVer::parse("2026.1001.0").unwrap());
    }
}
