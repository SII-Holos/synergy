// ================================================================
// WFP provider & sublayer key contracts
// ================================================================

pub mod filter_specs;
pub const PROVIDER_KEY: &str = "f8a1b2c3-d4e5-4f6a-7890-abcdef012345";
pub const SUBLAYER_KEY: &str = "1a2b3c4d-5e6f-7890-abcd-ef0123456789";

pub fn install_wfp_filters() -> Result<usize, String> {
    Ok(0)
}

#[allow(dead_code)]
pub fn install_wfp_filters_for_account(_username: &str) -> Result<usize, String> {
    Ok(0)
}

// ================================================================
// Tests: WFP provider/sublayer key contracts
// ================================================================
#[cfg(test)]
mod tests {
    #[test]
    fn provider_and_sublayer_keys_are_distinct() {
        assert_ne!(
            super::PROVIDER_KEY,
            super::SUBLAYER_KEY,
            "PROVIDER_KEY and SUBLAYER_KEY must be distinct GUIDs"
        );
    }

    #[test]
    fn provider_key_is_nonzero() {
        let nil = "00000000-0000-0000-0000-000000000000";
        assert_ne!(
            super::PROVIDER_KEY,
            nil,
            "PROVIDER_KEY must not be the nil GUID"
        );
    }

    #[test]
    fn sublayer_key_is_nonzero() {
        let nil = "00000000-0000-0000-0000-000000000000";
        assert_ne!(
            super::SUBLAYER_KEY,
            nil,
            "SUBLAYER_KEY must not be the nil GUID"
        );
    }

    #[test]
    fn install_wfp_filters_returns_zero_on_non_windows() {
        let result = super::install_wfp_filters();
        assert!(
            result.is_ok(),
            "install_wfp_filters must return Ok on any platform"
        );
        assert_eq!(
            result.unwrap(),
            0,
            "install_wfp_filters stub must return 0 filters installed"
        );
    }

    #[test]
    fn provider_key_is_uuid_form() {
        let key = super::PROVIDER_KEY;
        assert_eq!(key.len(), 36, "PROVIDER_KEY must be 36 characters");
        assert_eq!(key.chars().nth(8), Some('-'));
        assert_eq!(key.chars().nth(13), Some('-'));
        assert_eq!(key.chars().nth(18), Some('-'));
        assert_eq!(key.chars().nth(23), Some('-'));
    }

    #[test]
    fn sublayer_key_is_uuid_form() {
        let key = super::SUBLAYER_KEY;
        assert_eq!(key.len(), 36, "SUBLAYER_KEY must be 36 characters");
        assert_eq!(key.chars().nth(8), Some('-'));
        assert_eq!(key.chars().nth(13), Some('-'));
        assert_eq!(key.chars().nth(18), Some('-'));
        assert_eq!(key.chars().nth(23), Some('-'));
    }

    #[test]
    fn install_wfp_filters_for_account_stub_returns_ok_zero() {
        let result = super::install_wfp_filters_for_account("testuser");
        assert!(
            result.is_ok(),
            "install_wfp_filters_for_account stub must return Ok"
        );
        assert_eq!(
            result.unwrap(),
            0,
            "install_wfp_filters_for_account stub must return 0"
        );
    }
}
