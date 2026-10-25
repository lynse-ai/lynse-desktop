//! Versioned native-only authenticated encryption. No key is returned over IPC.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hkdf::Hkdf;
use libsodium_rs::{
    crypto_aead::xchacha20poly1305 as aead, crypto_pwhash,
    crypto_secretstream::xchacha20poly1305 as stream, crypto_sign, random,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use zeroize::{Zeroize, Zeroizing};

use crate::CommandResult;

pub const CHUNK: usize = 1024 * 1024;
pub const MAX_FILE: u64 = 200 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"LYNSEF01";

#[derive(Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub nonce: String,
    pub ciphertext: String,
}

pub fn init() -> CommandResult<()> {
    libsodium_rs::ensure_init().map_err(|_| "crypto_unavailable".into())
}

pub fn random_key() -> CommandResult<Zeroizing<Vec<u8>>> {
    init()?;
    let mut key = Zeroizing::new(vec![0; 32]);
    random::fill_bytes(&mut key);
    Ok(key)
}

pub fn encode(bytes: &[u8]) -> String {
    B64.encode(bytes)
}
pub fn decode(text: &str) -> CommandResult<Zeroizing<Vec<u8>>> {
    B64.decode(text)
        .map(Zeroizing::new)
        .map_err(|_| "invalid_crypto_envelope".into())
}

pub fn seal(key: &[u8], bytes: &[u8], ad: &[u8]) -> CommandResult<Envelope> {
    init()?;
    let key = aead::Key::from_bytes(key).map_err(|_| "invalid_crypto_key")?;
    let nonce = aead::Nonce::generate();
    let ciphertext =
        aead::encrypt(bytes, Some(ad), &nonce, &key).map_err(|_| "encryption_failed")?;
    Ok(Envelope {
        nonce: encode(nonce.as_ref()),
        ciphertext: encode(&ciphertext),
    })
}

pub fn open(key: &[u8], envelope: &Envelope, ad: &[u8]) -> CommandResult<Zeroizing<Vec<u8>>> {
    init()?;
    let nonce: [u8; 24] = decode(&envelope.nonce)?
        .as_slice()
        .try_into()
        .map_err(|_| "invalid_crypto_envelope")?;
    let key = aead::Key::from_bytes(key).map_err(|_| "invalid_crypto_key")?;
    aead::decrypt(
        &decode(&envelope.ciphertext)?,
        Some(ad),
        &aead::Nonce::from_bytes(nonce),
        &key,
    )
    .map(Zeroizing::new)
    .map_err(|_| "decryption_failed".into())
}

pub fn aad(purpose: &str, scope: &str, id: &str, revision: &str, epoch: u64) -> Vec<u8> {
    serde_json::to_vec(&json!([
        "lynse-inspiration",
        1,
        purpose,
        scope,
        id,
        revision,
        epoch
    ]))
    .expect("fixed AAD")
}

pub fn seal_record(
    root: &[u8],
    scope: &str,
    id: &str,
    epoch: u64,
    payload: &Value,
) -> CommandResult<Value> {
    let revision = uuid::Uuid::new_v4().to_string();
    let key = random_key()?;
    let plain = Zeroizing::new(serde_json::to_vec(payload).map_err(|_| "invalid_record")?);
    let content = seal(&key, &plain, &aad("payload", scope, id, &revision, 0))?;
    let wrapped = seal(root, &key, &aad("record-key", scope, id, &revision, epoch))?;
    Ok(
        json!({"crypto_version":1,"content_revision":revision,"key_epoch":epoch,
        "envelope":{"payload":content,"wrapped_key":wrapped}}),
    )
}

pub fn open_record(root: &[u8], scope: &str, row: &Value) -> CommandResult<Sensitive> {
    if row["account_scope"].as_str() != Some(scope) || row["crypto_version"] != 1 {
        return Err("record_scope_mismatch".into());
    }
    let id = row["id"].as_str().ok_or("invalid_record")?;
    let revision = row["content_revision"].as_str().ok_or("invalid_record")?;
    let epoch = row["key_epoch"].as_u64().ok_or("invalid_record")?;
    let wrapped: Envelope = serde_json::from_value(row["envelope"]["wrapped_key"].clone())
        .map_err(|_| "invalid_crypto_envelope")?;
    let key = open(
        root,
        &wrapped,
        &aad("record-key", scope, id, revision, epoch),
    )?;
    let content: Envelope = serde_json::from_value(row["envelope"]["payload"].clone())
        .map_err(|_| "invalid_crypto_envelope")?;
    let bytes = open(&key, &content, &aad("payload", scope, id, revision, 0))?;
    Ok(Sensitive(
        serde_json::from_slice(&bytes).map_err(|_| "invalid_record")?,
    ))
}

pub fn local_key(
    password: &[u8],
    device: &[u8],
    salt: &[u8],
    scope: &str,
) -> CommandResult<Zeroizing<Vec<u8>>> {
    init()?;
    if password.len() > 1024 || device.len() != 32 || salt.len() != crypto_pwhash::SALTBYTES {
        return Err("invalid_unlock_parameters".into());
    }
    let derived = Zeroizing::new(
        crypto_pwhash::pwhash(
            32,
            password,
            salt,
            3,
            256 * 1024 * 1024,
            crypto_pwhash::ALG_ARGON2ID13,
        )
        .map_err(|_| "password_derivation_failed")?,
    );
    let mut input = Zeroizing::new(derived.to_vec());
    input.extend_from_slice(device);
    let mut key = Zeroizing::new(vec![0; 32]);
    Hkdf::<Sha256>::new(None, &input)
        .expand(&aad("local-unlock", scope, "", "", 1), &mut key)
        .map_err(|_| "password_derivation_failed")?;
    Ok(key)
}

pub fn recovery_code() -> CommandResult<(String, Zeroizing<Vec<u8>>)> {
    let key = random_key()?;
    let raw = key.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let checksum = format!("{:x}", Sha256::digest(&*key));
    let groups = raw
        .as_bytes()
        .chunks(8)
        .map(|c| std::str::from_utf8(c).expect("hex"))
        .collect::<Vec<_>>();
    Ok((
        format!("LYNSE-{}-{}", groups.join("-"), &checksum[..8]),
        key,
    ))
}

pub fn parse_recovery(code: &str) -> CommandResult<Zeroizing<Vec<u8>>> {
    let raw = Zeroizing::new(
        code.trim()
            .to_ascii_lowercase()
            .replace("lynse-", "")
            .replace(['-', ' '], ""),
    );
    if raw.len() != 72 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid_recovery_code".into());
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(32));
    for offset in (0..64).step_by(2) {
        bytes.push(
            u8::from_str_radix(&raw[offset..offset + 2], 16)
                .map_err(|_| "invalid_recovery_code")?,
        );
    }
    let digest = format!("{:x}", Sha256::digest(&*bytes));
    if digest[..8] != raw[64..] {
        return Err("invalid_recovery_code".into());
    }
    Ok(bytes)
}

pub fn sign(seed: &[u8], value: &Value) -> CommandResult<String> {
    init()?;
    let pair = crypto_sign::KeyPair::from_seed(seed).map_err(|_| "invalid_device_key")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "invalid_signed_payload")?;
    crypto_sign::sign_detached(&bytes, &pair.secret_key)
        .map(|s| encode(&s))
        .map_err(|_| "signing_failed".into())
}

pub fn sign_public(seed: &[u8]) -> CommandResult<String> {
    init()?;
    Ok(encode(
        crypto_sign::KeyPair::from_seed(seed)
            .map_err(|_| "invalid_device_key")?
            .public_key
            .as_ref(),
    ))
}

pub fn verify(public: &str, signature: &str, value: &Value) -> CommandResult<()> {
    let public =
        crypto_sign::PublicKey::from_bytes(&decode(public)?).map_err(|_| "invalid_device_key")?;
    let sig: [u8; 64] = decode(signature)?
        .as_slice()
        .try_into()
        .map_err(|_| "invalid_signature")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "invalid_signed_payload")?;
    if crypto_sign::verify_detached(&sig, &bytes, &public) {
        Ok(())
    } else {
        Err("invalid_signature".into())
    }
}

pub fn encrypt_file<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    key: &[u8],
    ad: &[u8],
) -> CommandResult<u64> {
    init()?;
    let key = stream::Key::from_bytes(key).map_err(|_| "invalid_file_key")?;
    let (mut state, header) =
        stream::PushState::init_push(&key).map_err(|_| "encryption_failed")?;
    writer
        .write_all(MAGIC)
        .and_then(|_| writer.write_all(&header))
        .map_err(|_| "attachment_write_failed")?;
    let mut buffer = Zeroizing::new(vec![0; CHUNK]);
    let mut total = 0;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| "attachment_read_failed")?;
        total += count as u64;
        if total > MAX_FILE {
            return Err("attachment_too_large".into());
        }
        let tag = if count == 0 {
            stream::TAG_FINAL
        } else {
            stream::TAG_MESSAGE
        };
        let cipher = state
            .push(&buffer[..count], Some(ad), tag)
            .map_err(|_| "encryption_failed")?;
        writer
            .write_all(&(cipher.len() as u32).to_be_bytes())
            .and_then(|_| writer.write_all(&cipher))
            .map_err(|_| "attachment_write_failed")?;
        if count == 0 {
            return Ok(total);
        }
    }
}

pub fn decrypt_file<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    key: &[u8],
    ad: &[u8],
) -> CommandResult<()> {
    init()?;
    let mut magic = [0; 8];
    let mut header = [0; stream::HEADERBYTES];
    reader
        .read_exact(&mut magic)
        .and_then(|_| reader.read_exact(&mut header))
        .map_err(|_| "attachment_truncated")?;
    if &magic != MAGIC {
        return Err("invalid_attachment_format".into());
    }
    let key = stream::Key::from_bytes(key).map_err(|_| "invalid_file_key")?;
    let mut state = stream::PullState::init_pull(&header, &key).map_err(|_| "decryption_failed")?;
    let mut total = 0u64;
    loop {
        let mut length = [0; 4];
        reader
            .read_exact(&mut length)
            .map_err(|_| "attachment_truncated")?;
        let length = u32::from_be_bytes(length) as usize;
        if !(stream::ABYTES..=CHUNK + stream::ABYTES).contains(&length) {
            return Err("invalid_attachment_frame".into());
        }
        let mut cipher = vec![0; length];
        reader
            .read_exact(&mut cipher)
            .map_err(|_| "attachment_truncated")?;
        let (mut plain, tag) = state
            .pull(&cipher, Some(ad))
            .map_err(|_| "attachment_authentication_failed")?;
        total += plain.len() as u64;
        if total > MAX_FILE {
            plain.zeroize();
            return Err("attachment_too_large".into());
        }
        let result = writer
            .write_all(&plain)
            .map_err(|_| "attachment_write_failed".to_owned());
        plain.zeroize();
        result?;
        if tag == stream::TAG_FINAL {
            let mut trailing = [0];
            if reader
                .read(&mut trailing)
                .map_err(|_| "attachment_read_failed")?
                != 0
            {
                return Err("attachment_trailing_data".into());
            }
            return Ok(());
        }
        if tag != stream::TAG_MESSAGE {
            return Err("invalid_attachment_tag".into());
        }
    }
}

pub struct Sensitive(pub Value);
impl Drop for Sensitive {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}
pub fn wipe(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe),
        Value::Object(o) => o.values_mut().for_each(wipe),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signatures_match_backend_canonical_utf8_json() {
        let value = json!({"action":"save","account_scope":"scope","payload":{"text":"汉字 🧠","tags":["中文"],"ai":false}});
        assert_eq!(sign(&[1;32],&value).unwrap(),"KdiEHW6k5K2a13R3/BaRM+DimdnQ7yzTUbJacTX3xJb+1CiUKohyXi3m4rYRvEov/iGJJDTfbE74HnXw3Fc9DA==");
    }
    #[test]
    fn upstream_xchacha20poly1305_vector() {
        // libsodium test/default/aead_xchacha20poly1305.{c,exp}, first vector.
        init().unwrap();
        let key = aead::Key::from_bytes(&(0x80..=0x9f).collect::<Vec<u8>>()).unwrap();
        let nonce = aead::Nonce::from_bytes([
            7, 0, 0, 0, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b,
            0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0x53,
        ]);
        let ad = [
            0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
        ];
        let message=b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
        let cipher = aead::encrypt(message, Some(&ad), &nonce, &key).unwrap();
        let actual = cipher
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(actual,"f8ebea4875044066fc162a0604e171feecfb3d20425248563bcfd5a155dcc47bbda70b86e5ab9b55002bd1274c02db35321acd7af8b2e2d25015e136b7679458e9f43243bf719d639badb5feac03f80a19a96ef10cb1d15333a837b90946ba3854ee74da3f2585efc7e1e170e17e15e563e77601f4f85cafa8e5877614e143e68420");
    }
    #[test]
    fn passwords_device_secrets_and_account_scope_are_all_required() {
        let device = random_key().unwrap();
        let salt = vec![4; crypto_pwhash::SALTBYTES];
        let first = local_key(b"correct password", &device, &salt, "alice").unwrap();
        assert_eq!(
            *first,
            *local_key(b"correct password", &device, &salt, "alice").unwrap()
        );
        for (password, secret, owner) in [
            (b"wrong password".as_slice(), device.as_slice(), "alice"),
            (b"correct password".as_slice(), device.as_slice(), "bob"),
        ] {
            assert_ne!(*first, *local_key(password, secret, &salt, owner).unwrap());
        }
        assert_ne!(
            *first,
            *local_key(b"correct password", &random_key().unwrap(), &salt, "alice").unwrap()
        );
    }
    #[test]
    fn stream_rejects_reordered_repeated_frames_and_replaced_header() {
        let key = random_key().unwrap();
        let mut cipher = Vec::new();
        encrypt_file(
            &mut vec![9; CHUNK * 2 + 8].as_slice(),
            &mut cipher,
            &key,
            b"owner",
        )
        .unwrap();
        let first_end = 32 + 4 + u32::from_be_bytes(cipher[32..36].try_into().unwrap()) as usize;
        let second_end = first_end
            + 4
            + u32::from_be_bytes(cipher[first_end..first_end + 4].try_into().unwrap()) as usize;
        let mut swapped = cipher[..32].to_vec();
        swapped.extend_from_slice(&cipher[first_end..second_end]);
        swapped.extend_from_slice(&cipher[32..first_end]);
        swapped.extend_from_slice(&cipher[second_end..]);
        assert!(decrypt_file(&mut swapped.as_slice(), &mut Vec::new(), &key, b"owner").is_err());
        let mut repeated = cipher[..first_end].to_vec();
        repeated.extend_from_slice(&cipher[32..]);
        assert!(decrypt_file(&mut repeated.as_slice(), &mut Vec::new(), &key, b"owner").is_err());
        cipher[12] ^= 1;
        assert!(decrypt_file(&mut cipher.as_slice(), &mut Vec::new(), &key, b"owner").is_err());
    }
    #[test]
    fn envelopes_bind_scope_revision_and_epoch() {
        let root = random_key().unwrap();
        let encrypted = seal_record(
            &root,
            "alice",
            "inspiration:one",
            1,
            &json!({"text":"private canary"}),
        )
        .unwrap();
        let mut row = encrypted.clone();
        row["id"] = json!("inspiration:one");
        row["account_scope"] = json!("alice");
        assert_eq!(
            open_record(&root, "alice", &row).unwrap().0["text"],
            "private canary"
        );
        assert!(open_record(&root, "bob", &row).is_err());
        row["key_epoch"] = json!(2);
        assert!(open_record(&root, "alice", &row).is_err());
        assert!(!encrypted.to_string().contains("private canary"));
    }
    #[test]
    fn stream_rejects_truncation_tampering_trailing_bytes_and_wrong_owner() {
        let key = random_key().unwrap();
        let ad = b"alice/record/file";
        let plain = vec![7; CHUNK + 71];
        let mut cipher = Vec::new();
        encrypt_file(&mut plain.as_slice(), &mut cipher, &key, ad).unwrap();
        let mut restored = Vec::new();
        decrypt_file(&mut cipher.as_slice(), &mut restored, &key, ad).unwrap();
        assert_eq!(plain, restored);
        assert!(decrypt_file(&mut &cipher[..cipher.len() - 1], &mut Vec::new(), &key, ad).is_err());
        assert!(decrypt_file(
            &mut cipher.as_slice(),
            &mut Vec::new(),
            &key,
            b"bob/record/file"
        )
        .is_err());
        let mut changed = cipher.clone();
        changed[40] ^= 1;
        assert!(decrypt_file(&mut changed.as_slice(), &mut Vec::new(), &key, ad).is_err());
        cipher.push(0);
        assert!(decrypt_file(&mut cipher.as_slice(), &mut Vec::new(), &key, ad).is_err());
    }
    #[test]
    fn empty_files_and_recovery_checksums_round_trip() {
        let (code, key) = recovery_code().unwrap();
        assert_eq!(*parse_recovery(&code).unwrap(), *key);
        assert!(parse_recovery(&(code + "0")).is_err());
        let mut cipher = Vec::new();
        encrypt_file(&mut &b""[..], &mut cipher, &key, b"test").unwrap();
        let mut plain = Vec::new();
        decrypt_file(&mut cipher.as_slice(), &mut plain, &key, b"test").unwrap();
        assert!(plain.is_empty());
    }
}
