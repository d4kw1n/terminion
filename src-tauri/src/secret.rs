//! Secret storage helpers.
//!
//! On Windows every secret (passwords, private keys, passphrases) is sealed with
//! DPAPI in the current user's context before being written to SQLite, so the
//! database file alone is not enough to recover credentials.

#[cfg(windows)]
use base64::engine::general_purpose::STANDARD as B64;
#[cfg(windows)]
use base64::Engine;

#[cfg(windows)]
pub fn seal(plain: &[u8]) -> Result<String, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(format!(
                "could not encrypt secret: {}",
                std::io::Error::last_os_error()
            ));
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(B64.encode(bytes))
    }
}

#[cfg(windows)]
pub fn unseal(sealed: &str) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let raw = B64
        .decode(sealed.trim())
        .map_err(|e| format!("secret is not valid base64: {e}"))?;
    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: raw.len() as u32,
            pbData: raw.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            return Err(format!(
                "could not decrypt secret: {}",
                std::io::Error::last_os_error()
            ));
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(bytes)
    }
}

// This build is Windows-first. Fail closed on other platforms rather than
// silently writing credentials as recoverable base64.
#[cfg(not(windows))]
pub fn seal(_plain: &[u8]) -> Result<String, String> {
    Err("Secret storage requires Windows DPAPI; this platform build is unsupported".into())
}

#[cfg(not(windows))]
pub fn unseal(_sealed: &str) -> Result<Vec<u8>, String> {
    Err("Secret storage requires Windows DPAPI; this platform build is unsupported".into())
}

pub fn seal_str(plain: &str) -> Result<String, String> {
    seal(plain.as_bytes())
}

pub fn unseal_str(sealed: &str) -> Result<String, String> {
    let bytes = unseal(sealed)?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}
