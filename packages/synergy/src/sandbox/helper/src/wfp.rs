// ================================================================
// WFP provider & sublayer key contracts
// ================================================================

pub mod filter_specs;
pub const PROVIDER_KEY: &str = "f8a1b2c3-d4e5-4f6a-7890-abcdef012345";
pub const SUBLAYER_KEY: &str = "1a2b3c4d-5e6f-7890-abcd-ef0123456789";

// ================================================================
// Windows: real WFP engine management
// ================================================================
#[cfg(target_os = "windows")]
mod platform {
    use std::ptr;

    use windows_sys::core::{GUID, PWSTR};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::NetworkManagement::WindowsFilteringPlatform::*;
    use windows_sys::Win32::Security::{LookupAccountNameW, SidTypeUser, PSID, SID_NAME_USE};
    use windows_sys::Win32::System::Rpc::SEC_WINNT_AUTH_IDENTITY_W;

    use crate::wfp::filter_specs::FilterSpec;

    /// Parse a GUID string "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" into a windows_sys GUID.
    fn parse_guid(s: &str) -> Result<GUID, String> {
        let s = s.trim();
        if s.len() != 36 {
            return Err(format!("GUID must be 36 chars, got {}", s.len()));
        }
        let d1 = u32::from_str_radix(&s[0..8], 16).map_err(|e| format!("GUID d1: {e}"))?;
        let d2 = u16::from_str_radix(&s[9..13], 16).map_err(|e| format!("GUID d2: {e}"))?;
        let d3 = u16::from_str_radix(&s[14..18], 16).map_err(|e| format!("GUID d3: {e}"))?;
        let d4a = u16::from_str_radix(&s[19..23], 16).map_err(|e| format!("GUID d4a: {e}"))?;
        let mut d4 = [0u8; 8];
        d4[0] = (d4a >> 8) as u8;
        d4[1] = (d4a & 0xff) as u8;
        for i in 0..6 {
            d4[2 + i] = u8::from_str_radix(&s[24 + i * 2..26 + i * 2], 16)
                .map_err(|e| format!("GUID d4b[{i}]: {e}"))?;
        }
        Ok(GUID {
            data1: d1,
            data2: d2,
            data3: d3,
            data4: d4,
        })
    }

    /// Encode a Rust string as a null-terminated wide string on the heap.
    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn open_wfp_engine() -> Result<HANDLE, String> {
        let session = FWPM_SESSION0 {
            sessionKey: GUID {
                data1: 0,
                data2: 0,
                data3: 0,
                data4: [0; 8],
            },
            displayData: FWPM_DISPLAY_DATA0 {
                name: ptr::null_mut(),
                description: ptr::null_mut(),
            },
            flags: FWPM_SESSION_FLAG_DYNAMIC,
            txnWaitTimeoutInMSec: 0,
            processId: 0,
            sid: ptr::null_mut(),
            username: ptr::null_mut(),
            kernelMode: 0,
        };
        let mut engine: HANDLE = 0;
        let status = unsafe { FwpmEngineOpen0(ptr::null(), 0, ptr::null(), &session, &mut engine) };
        if status != 0 {
            return Err(format!("FwpmEngineOpen0 failed: 0x{status:08x}"));
        }
        Ok(engine)
    }

    pub fn register_provider(engine: HANDLE, provider_key: &GUID) -> Result<(), String> {
        let name = to_wide("Synergy Sandbox");
        let desc = to_wide("Synergy sandbox network isolation provider");
        let provider = FWPM_PROVIDER0 {
            providerKey: *provider_key,
            displayData: FWPM_DISPLAY_DATA0 {
                name: name.as_ptr() as *mut u16,
                description: desc.as_ptr() as *mut u16,
            },
            flags: 0,
            providerData: FWP_BYTE_BLOB {
                size: 0,
                data: ptr::null_mut(),
            },
            serviceName: ptr::null_mut(),
        };
        let status = unsafe { FwpmProviderAdd0(engine, &provider, ptr::null_mut()) };
        drop(desc);
        drop(name);
        if status != 0 {
            return Err(format!("FwpmProviderAdd0 failed: 0x{status:08x}"));
        }
        Ok(())
    }

    pub fn register_sublayer(
        engine: HANDLE,
        sublayer_key: &GUID,
        provider_key: &GUID,
    ) -> Result<(), String> {
        let name = to_wide("Synergy Sandbox Sublayer");
        let desc = to_wide("Synergy sandbox network isolation sublayer");
        let sublayer = FWPM_SUBLAYER0 {
            subLayerKey: *sublayer_key,
            displayData: FWPM_DISPLAY_DATA0 {
                name: name.as_ptr() as *mut u16,
                description: desc.as_ptr() as *mut u16,
            },
            flags: 0,
            providerKey: provider_key as *const GUID as *mut GUID,
            providerData: FWP_BYTE_BLOB {
                size: 0,
                data: ptr::null_mut(),
            },
            weight: 0xFFFF,
        };
        let status = unsafe { FwpmSubLayerAdd0(engine, &sublayer, ptr::null_mut()) };
        drop(desc);
        drop(name);
        if status != 0 {
            return Err(format!("FwpmSubLayerAdd0 failed: 0x{status:08x}"));
        }
        Ok(())
    }

    /// Look up a Windows account name and return its SID.
    /// Returns (sid_ptr, backing_buffer). The buffer must be kept alive while sid_ptr is used.
    pub fn lookup_user_sid(username: &str) -> Result<(PSID, Vec<u8>), String> {
        let username_wide = to_wide(username);
        let mut sid_size: u32 = 0;
        let mut domain_size: u32 = 0;
        let mut sid_use: SID_NAME_USE = SidTypeUser;

        // First call: get required buffer sizes
        unsafe {
            LookupAccountNameW(
                ptr::null(),
                username_wide.as_ptr(),
                ptr::null_mut(),
                &mut sid_size,
                ptr::null_mut(),
                &mut domain_size,
                &mut sid_use,
            );
        }
        if sid_size == 0 {
            return Err(format!(
                "LookupAccountNameW failed to get size for '{username}'"
            ));
        }

        let mut sid_buf: Vec<u8> = vec![0u8; sid_size as usize];
        let mut domain_buf: Vec<u16> = vec![0u16; domain_size as usize];

        let ok = unsafe {
            LookupAccountNameW(
                ptr::null(),
                username_wide.as_ptr(),
                sid_buf.as_mut_ptr() as PSID,
                &mut sid_size,
                domain_buf.as_mut_ptr(),
                &mut domain_size,
                &mut sid_use,
            )
        };
        if ok == 0 {
            return Err(format!("LookupAccountNameW failed for '{username}'"));
        }

        Ok((sid_buf.as_mut_ptr() as PSID, sid_buf))
    }

    /// Parse the user_condition string into a list of FWPM_FILTER_CONDITION0 conditions
    /// plus the ALE user SID condition.
    fn build_filter_conditions(
        spec: &FilterSpec,
        user_sid: PSID,
    ) -> Result<Vec<FWPM_FILTER_CONDITION0>, String> {
        let mut conditions: Vec<FWPM_FILTER_CONDITION0> = Vec::new();

        if !user_sid.is_null() {
            let mut sid_condition = FWPM_FILTER_CONDITION0 {
                fieldKey: FWPM_CONDITION_ALE_USER_ID,
                matchType: FWP_MATCH_EQUAL,
                conditionValue: FWP_CONDITION_VALUE0 {
                    r#type: FWP_SID,
                    Anonymous: unsafe { std::mem::zeroed() },
                },
            };
            unsafe {
                sid_condition.conditionValue.Anonymous.sid = user_sid;
            }
            conditions.push(sid_condition);
        }

        // Parse user_condition string like "ip_protocol == 1 && remote_port == 0"
        let cond = spec.user_condition;
        let parts: Vec<&str> = cond.split("&&").collect();

        for part in parts {
            let part = part.trim();
            let mut kv = part.split("==");
            let key = kv.next().unwrap_or("").trim();
            let val_str = kv.next().unwrap_or("").trim();
            let value: u32 = val_str
                .parse()
                .map_err(|e| format!("bad value in '{part}': {e}"))?;

            match key {
                "ip_protocol" => {
                    conditions.push(FWPM_FILTER_CONDITION0 {
                        fieldKey: FWPM_CONDITION_IP_PROTOCOL,
                        matchType: FWP_MATCH_EQUAL,
                        conditionValue: FWP_CONDITION_VALUE0 {
                            r#type: FWP_UINT8,
                            Anonymous: FWP_CONDITION_VALUE0_0 { uint8: value as u8 },
                        },
                    });
                }
                "remote_port" => {
                    conditions.push(FWPM_FILTER_CONDITION0 {
                        fieldKey: FWPM_CONDITION_IP_REMOTE_PORT,
                        matchType: FWP_MATCH_EQUAL,
                        conditionValue: FWP_CONDITION_VALUE0 {
                            r#type: FWP_UINT16,
                            Anonymous: FWP_CONDITION_VALUE0_0 {
                                uint16: value as u16,
                            },
                        },
                    });
                }
                _ => {
                    return Err(format!(
                        "unknown condition key '{key}' in filter '{}'",
                        spec.name
                    ));
                }
            }
        }

        Ok(conditions)
    }

    pub fn install_filters(
        engine: HANDLE,
        provider_key: &GUID,
        sublayer_key: &GUID,
        user_sid: PSID,
    ) -> Result<usize, String> {
        let specs = crate::wfp::filter_specs::get_filter_specs();
        let mut installed = 0usize;

        for spec in specs.iter() {
            let filter_key = parse_guid(spec.key)?;
            let name_wide = to_wide(spec.name);
            let desc_wide = to_wide(spec.description);

            let conditions = build_filter_conditions(spec, user_sid)?;

            let layer_key = GUID {
                data1: spec.layer_id as u32,
                data2: 0,
                data3: 0,
                data4: [0; 8],
            };

            let filter = FWPM_FILTER0 {
                filterKey: filter_key,
                displayData: FWPM_DISPLAY_DATA0 {
                    name: name_wide.as_ptr() as *mut u16,
                    description: desc_wide.as_ptr() as *mut u16,
                },
                flags: FWPM_FILTER_FLAG_NONE,
                providerKey: provider_key as *const GUID as *mut GUID,
                providerData: FWP_BYTE_BLOB {
                    size: 0,
                    data: ptr::null_mut(),
                },
                layerKey: layer_key,
                subLayerKey: *sublayer_key,
                weight: FWP_VALUE0 {
                    r#type: FWP_UINT8,
                    Anonymous: FWP_VALUE0_0 { uint8: 0 },
                },
                numFilterConditions: conditions.len() as u32,
                filterCondition: conditions.as_ptr() as *mut FWPM_FILTER_CONDITION0,
                action: FWPM_ACTION0 {
                    r#type: FWP_ACTION_PERMIT,
                    Anonymous: FWPM_ACTION0_0 {
                        filterType: GUID {
                            data1: 0,
                            data2: 0,
                            data3: 0,
                            data4: [0; 8],
                        },
                    },
                },
                Anonymous: FWPM_FILTER0_0 { rawContext: 0 },
                reserved: ptr::null_mut(),
                filterId: 0,
                effectiveWeight: FWP_VALUE0 {
                    r#type: FWP_EMPTY,
                    Anonymous: FWP_VALUE0_0 { uint8: 0 },
                },
            };

            let status =
                unsafe { FwpmFilterAdd0(engine, &filter, ptr::null_mut(), ptr::null_mut()) };

            drop(desc_wide);
            drop(name_wide);
            drop(conditions);

            if status != 0 {
                log::warn!(
                    "WFP: FwpmFilterAdd0 failed for '{}': 0x{status:08x}",
                    spec.name
                );
                continue;
            }
            installed += 1;
        }

        Ok(installed)
    }

    pub fn uninstall_filters(engine: HANDLE) -> Result<(), String> {
        let specs = crate::wfp::filter_specs::get_filter_specs();
        let mut last_err = None;

        for spec in specs.iter() {
            let filter_key = match parse_guid(spec.key) {
                Ok(k) => k,
                Err(e) => {
                    log::warn!("WFP: bad filter key '{}': {e}", spec.name);
                    continue;
                }
            };

            let status = unsafe { FwpmFilterDeleteByKey0(engine, &filter_key) };
            if status != 0 {
                log::warn!(
                    "WFP: FwpmFilterDeleteByKey0 failed for '{}': 0x{status:08x}",
                    spec.name
                );
                last_err = Some(format!(
                    "FwpmFilterDeleteByKey0 failed for '{}': 0x{status:08x}",
                    spec.name
                ));
            }
        }

        if let Some(err) = last_err {
            Err(err)
        } else {
            Ok(())
        }
    }

    pub fn close_engine(engine: HANDLE) -> Result<(), String> {
        let status = unsafe { FwpmEngineClose0(engine) };
        if status != 0 {
            return Err(format!("FwpmEngineClose0 failed: 0x{status:08x}"));
        }
        Ok(())
    }

    pub fn register_provider_and_sublayer(
        engine: HANDLE,
        provider_key: &GUID,
        sublayer_key: &GUID,
    ) -> Result<(), String> {
        register_provider(engine, provider_key).or_else(|e| {
            if e.contains("already exists") {
                Ok(())
            } else {
                Err(e)
            }
        })?;
        register_sublayer(engine, sublayer_key, provider_key).or_else(|e| {
            if e.contains("already exists") {
                Ok(())
            } else {
                Err(e)
            }
        })?;
        Ok(())
    }
}

pub fn install_wfp_filters() -> Result<usize, String> {
    #[cfg(not(target_os = "windows"))]
    {
        Ok(0)
    }
    #[cfg(target_os = "windows")]
    {
        unsafe {
            let engine = platform::open_wfp_engine()?;
            let provider_key =
                platform::parse_guid(PROVIDER_KEY).map_err(|e| format!("provider key: {e}"))?;
            let sublayer_key =
                platform::parse_guid(SUBLAYER_KEY).map_err(|e| format!("sublayer key: {e}"))?;

            platform::register_provider_and_sublayer(engine, &provider_key, &sublayer_key)?;

            // Install filters without per-user SID (system-wide allow rules)
            let count = platform::install_filters(
                engine,
                &provider_key,
                &sublayer_key,
                std::ptr::null_mut(),
            )?;

            platform::close_engine(engine)?;
            Ok(count)
        }
    }
}

pub fn install_wfp_filters_for_account(username: &str) -> Result<usize, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = username;
        Ok(0)
    }
    #[cfg(target_os = "windows")]
    {
        unsafe {
            let engine = platform::open_wfp_engine()?;
            let provider_key =
                platform::parse_guid(PROVIDER_KEY).map_err(|e| format!("provider key: {e}"))?;
            let sublayer_key =
                platform::parse_guid(SUBLAYER_KEY).map_err(|e| format!("sublayer key: {e}"))?;

            platform::register_provider_and_sublayer(engine, &provider_key, &sublayer_key)?;

            let (_sid_ptr, _sid_buf) = platform::lookup_user_sid(username)?;
            let count = platform::install_filters(engine, &provider_key, &sublayer_key, _sid_ptr)?;

            platform::close_engine(engine)?;
            Ok(count)
        }
    }
}

// ================================================================
// Tests: WFP provider/sublayer key contracts
// ================================================================
#[cfg(test)]
mod tests {
    #[test]
    fn provider_and_sublayer_keys_are_distinct() {
        assert_ne!(super::PROVIDER_KEY, super::SUBLAYER_KEY);
    }

    #[test]
    fn provider_key_is_nonzero() {
        let nil = "00000000-0000-0000-0000-000000000000";
        assert_ne!(super::PROVIDER_KEY, nil);
    }

    #[test]
    fn sublayer_key_is_nonzero() {
        let nil = "00000000-0000-0000-0000-000000000000";
        assert_ne!(super::SUBLAYER_KEY, nil);
    }

    #[test]
    fn install_wfp_filters_returns_zero_on_non_windows() {
        let result = super::install_wfp_filters();
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }

    #[test]
    fn provider_key_is_uuid_form() {
        let key = super::PROVIDER_KEY;
        assert_eq!(key.len(), 36);
        assert_eq!(key.chars().nth(8), Some('-'));
        assert_eq!(key.chars().nth(13), Some('-'));
        assert_eq!(key.chars().nth(18), Some('-'));
        assert_eq!(key.chars().nth(23), Some('-'));
    }

    #[test]
    fn sublayer_key_is_uuid_form() {
        let key = super::SUBLAYER_KEY;
        assert_eq!(key.len(), 36);
        assert_eq!(key.chars().nth(8), Some('-'));
        assert_eq!(key.chars().nth(13), Some('-'));
        assert_eq!(key.chars().nth(18), Some('-'));
        assert_eq!(key.chars().nth(23), Some('-'));
    }

    #[test]
    fn install_wfp_filters_for_account_stub_returns_ok_zero() {
        let result = super::install_wfp_filters_for_account("testuser");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), 0);
    }
}
