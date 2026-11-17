//! nusb transport for the recording card: enumeration, vendor-interface
//! claim, control-transfer password handshake and bulk frame I/O.
//!
//! Requests are `*APP#…#`; device responses are `*DEV#…#`. Text exchanges use
//! a small pending buffer because one bulk-IN transfer can contain several
//! frames or only part of a frame. Raw `read_frame()` is kept for downloads.
//! Bulk endpoints are opened once from the vendor interface and reused for the
//! whole session; nusb claims them exclusively, so recreating them per command
//! made concurrent `listFiles`/`storage` calls fail with "endpoint already in
//! use".

use std::time::Duration;

use nusb::descriptors::TransferType;
use nusb::transfer::{
    Bulk, Buffer, ControlIn, ControlOut, ControlType, Direction, In, Out, Recipient,
};
use nusb::{Device, DeviceInfo, Endpoint, Interface};
use tokio::sync::Mutex;

use super::frames::{decode_frame_text, split_frame};
use super::protocol::{
    expected_fields, parse_response, response_command, response_prefix, DeviceResponse,
};

pub const DEFAULT_VENDOR_ID: u16 = 0x3654;
pub const DEFAULT_PRODUCT_ID: u16 = 0x4155;

const CONTROL_REQUEST_OUT: u8 = 0x12;
const CONTROL_REQUEST_IN: u8 = 0x13;
const FALLBACK_CONFIGURATION: u8 = 1;
const FALLBACK_INTERFACE: u8 = 0;
const FALLBACK_BULK_ENDPOINT_OUT: u8 = 0x02;
const FALLBACK_BULK_ENDPOINT_IN: u8 = 0x82;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_millis(1200);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_LOG_CHARS: usize = 160;

#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    #[error("recording card not found (VID 0x{vid:04x} / PID 0x{pid:04x})")]
    NotFound { vid: u16, pid: u16 },
    #[error("USB error: {0}")]
    Usb(String),
    #[error("password handshake failed: {0}")]
    Auth(String),
    #[error("transfer error: {0}")]
    Transfer(String),
    #[error("device disconnected")]
    Disconnected,
}

impl From<nusb::Error> for DeviceError {
    fn from(value: nusb::Error) -> Self {
        DeviceError::Usb(value.to_string())
    }
}

impl From<nusb::transfer::TransferError> for DeviceError {
    fn from(value: nusb::transfer::TransferError) -> Self {
        DeviceError::Transfer(value.to_string())
    }
}

/// Find the first recording card matching VID/PID.
pub async fn find_device(vendor_id: u16, product_id: u16) -> Result<DeviceInfo, DeviceError> {
    let devices = nusb::list_devices()
        .await
        .map_err(|e| DeviceError::Usb(e.to_string()))?;
    for device in devices {
        if device.vendor_id() == vendor_id && device.product_id() == product_id {
            log::info!(
                "[recording-card] found USB {:04x}:{:04x}",
                vendor_id,
                product_id
            );
            return Ok(device);
        }
    }
    Err(DeviceError::NotFound {
        vid: vendor_id,
        pid: product_id,
    })
}

/// Discover the vendor-specific interface and its bulk endpoint addresses.
/// Mirrors the WebUSB SDK: pick the `0xff` interface that has one bulk IN and
/// one bulk OUT endpoint, then use the full `bEndpointAddress` values.
fn find_vendor_interface(device: &Device) -> Option<(u8, u8, u8, u8)> {
    for config in device.configurations() {
        for intf in config.interfaces() {
            let alt = intf.first_alt_setting();
            if alt.class() != 0xff {
                continue;
            }
            let mut bulk_out = None;
            let mut bulk_in = None;
            for ep in alt.endpoints() {
                log::info!(
                    "[recording-card] descriptor endpoint address=0x{:02x} dir={:?} type={:?}",
                    ep.address(),
                    ep.direction(),
                    ep.transfer_type()
                );
                if ep.transfer_type() != TransferType::Bulk {
                    continue;
                }
                match ep.direction() {
                    Direction::Out => bulk_out = Some(ep.address()),
                    Direction::In => bulk_in = Some(ep.address()),
                }
            }
            if let (Some(out), Some(inn)) = (bulk_out, bulk_in) {
                return Some((
                    config.configuration_value(),
                    intf.interface_number(),
                    out,
                    inn,
                ));
            }
        }
    }
    None
}

/// An opened, authenticated recording card. Owns the claimed interface and
/// the two bulk endpoints for its whole lifetime; dropping it releases them.
pub struct CardDevice {
    // Kept alive for the lifetime of the session; dropping this releases the
    // claimed USB interface and its endpoints.
    #[allow(dead_code)]
    interface: Interface,
    pub vendor_id: u16,
    pub product_id: u16,
    authenticated: bool,
    bulk_out: Mutex<Endpoint<Bulk, Out>>,
    bulk_in: Mutex<Endpoint<Bulk, In>>,
    pending: Mutex<Vec<u8>>,
}

/// A `listreq`-style payload frame: full `#`-split header plus raw bytes.
#[derive(Debug, Clone)]
pub struct PayloadFrame {
    pub parts: Vec<String>,
    pub payload: Vec<u8>,
}

impl CardDevice {
    /// Open the device, claim its vendor interface and run the password
    /// control-transfer handshake. Captured sequence:
    ///   1. discover config/interface/bulk endpoints from descriptors
    ///   2. set_configuration + claim_interface + open both bulk endpoints once
    ///   3. drain any startup bulk-IN noise (best effort)
    ///   4. control OUT request=0x12, recipient=interface, data=UTF-8(password)
    ///   5. control IN  request=0x13, recipient=interface -> 0x01 = success
    pub async fn open_and_authenticate(
        info: &DeviceInfo,
        password: &str,
    ) -> Result<Self, DeviceError> {
        log::info!(
            "[recording-card] opening USB {:04x}:{:04x}",
            info.vendor_id(),
            info.product_id()
        );
        let device = info.open().await?;
        let (configuration, interface_number, bulk_out_address, bulk_in_address) =
            match find_vendor_interface(&device) {
                Some(found) => found,
                None => {
                    log::warn!(
                        "[recording-card] vendor bulk interface not found; using fallback config={} interface={} OUT=0x{:02x} IN=0x{:02x}",
                        FALLBACK_CONFIGURATION,
                        FALLBACK_INTERFACE,
                        FALLBACK_BULK_ENDPOINT_OUT,
                        FALLBACK_BULK_ENDPOINT_IN
                    );
                    (
                        FALLBACK_CONFIGURATION,
                        FALLBACK_INTERFACE,
                        FALLBACK_BULK_ENDPOINT_OUT,
                        FALLBACK_BULK_ENDPOINT_IN,
                    )
                }
            };
        log::info!(
            "[recording-card] config={} interface={} OUT=0x{:02x} IN=0x{:02x}",
            configuration,
            interface_number,
            bulk_out_address,
            bulk_in_address
        );

        device.set_configuration(configuration).await?;
        let interface = device.claim_interface(interface_number).await?;
        let bulk_out = interface
            .endpoint::<Bulk, Out>(bulk_out_address)
            .map_err(|e| DeviceError::Usb(e.to_string()))?;
        let mut bulk_in = interface
            .endpoint::<Bulk, In>(bulk_in_address)
            .map_err(|e| DeviceError::Usb(e.to_string()))?;

        // Drain startup noise before the handshake. The SDK reads a few
        // frames the device emits on open; tolerate a short quiet wait here.
        let _ = Self::drain_quiet(&mut bulk_in).await;

        interface
            .control_out(
                ControlOut {
                    control_type: ControlType::Standard,
                    recipient: Recipient::Interface,
                    request: CONTROL_REQUEST_OUT,
                    value: 0,
                    index: 0,
                    data: password.as_bytes(),
                },
                IO_TIMEOUT,
            )
            .await?;

        let result = interface
            .control_in(
                ControlIn {
                    control_type: ControlType::Standard,
                    recipient: Recipient::Interface,
                    request: CONTROL_REQUEST_IN,
                    value: 0,
                    index: 0,
                    length: 1,
                },
                IO_TIMEOUT,
            )
            .await?;

        if result.first() != Some(&0x01) {
            return Err(DeviceError::Auth(
                "口令校验失败，已断开连接".to_string(),
            ));
        }

        log::info!("[recording-card] password handshake ok");
        Ok(Self {
            interface,
            vendor_id: info.vendor_id(),
            product_id: info.product_id(),
            authenticated: true,
            bulk_out: Mutex::new(bulk_out),
            bulk_in: Mutex::new(bulk_in),
            pending: Mutex::new(Vec::new()),
        })
    }

    pub fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    async fn drain_quiet(ep: &mut Endpoint<Bulk, In>) -> Result<(), DeviceError> {
        // Best-effort short read of startup frames; a timeout here is normal
        // and must not fail the connection.
        let buf = Buffer::new(64);
        ep.submit(buf);
        if tokio::time::timeout(READ_TIMEOUT, ep.next_complete())
            .await
            .is_ok()
        {
            log::info!("[recording-card] drained a startup bulk frame");
        } else {
            ep.cancel_all();
            let _ = ep.next_complete().await.into_result();
        }
        Ok(())
    }

    /// Write a raw frame to the vendor bulk OUT endpoint.
    pub async fn write_frame(&self, frame: &[u8]) -> Result<usize, DeviceError> {
        log::info!(
            "[recording-card] bulk out {} bytes: {:?}",
            frame.len(),
            preview_text(frame)
        );
        let mut ep = self.bulk_out.lock().await;
        let mut buf = Buffer::new(frame.len());
        buf.extend_from_slice(frame);
        ep.submit(buf);
        match tokio::time::timeout(WRITE_TIMEOUT, ep.next_complete()).await {
            Ok(completion) => Ok(completion.into_result()?.len()),
            Err(_) => {
                ep.cancel_all();
                let _ = ep.next_complete().await.into_result();
                log::warn!(
                    "[recording-card] bulk out timed out after {:?}",
                    WRITE_TIMEOUT
                );
                Err(DeviceError::Transfer("bulk out timed out".to_string()))
            }
        }
    }

    /// Read one raw bulk-IN frame (up to 4096 bytes, matching the SDK).
    pub async fn read_frame(&self) -> Result<Vec<u8>, DeviceError> {
        let mut ep = self.bulk_in.lock().await;
        let buf = Buffer::new(4096);
        ep.submit(buf);
        match tokio::time::timeout(READ_TIMEOUT, ep.next_complete()).await {
            Ok(completion) => {
                let raw = completion.into_result()?.into_vec();
                log::info!(
                    "[recording-card] bulk in {} bytes: {:?}",
                    raw.len(),
                    preview_text(&raw)
                );
                Ok(raw)
            }
            Err(_) => {
                ep.cancel_all();
                let _ = ep.next_complete().await.into_result();
                log::warn!(
                    "[recording-card] bulk in timed out after {:?}",
                    READ_TIMEOUT
                );
                Err(DeviceError::Transfer("bulk in timed out".to_string()))
            }
        }
    }

    /// Send a command and read its matching `*DEV` response. Unrelated frames
    /// are logged and skipped; a bulk-read timeout no longer hides the final
    /// exchange error behind `?`.
    pub async fn exchange(
        &self,
        command: &str,
        frame: &[u8],
    ) -> Result<DeviceResponse, DeviceError> {
        let expected = response_command(command);
        let min_fields = expected_fields(expected).unwrap_or(1);
        log::info!(
            "[recording-card] exchange start cmd={} want={} min_fields={}",
            command,
            expected,
            min_fields
        );
        self.write_frame(frame).await?;
        let response = self
            .read_text_frame(expected, min_fields, IO_TIMEOUT)
            .await?;
        log::info!(
            "[recording-card] exchange ok cmd={} fields={:?}",
            command,
            response.fields
        );
        Ok(response)
    }

    /// Read one `*DEV#<command>#` text frame from the pending stream.
    /// `min_fields` is the SDK `C` count of `#`-terminated payload fields.
    pub async fn read_text_frame(
        &self,
        command: &str,
        min_fields: usize,
        timeout: Duration,
    ) -> Result<DeviceResponse, DeviceError> {
        let marker = frame_marker(response_prefix(), command);
        let deadline = tokio::time::Instant::now() + timeout;
        let mut reads = 0usize;

        loop {
            {
                let mut pending = self.pending.lock().await;
                strip_nulls(&mut pending);

                if let Some(start) = find_subslice(&pending, &marker) {
                    if start > 0 {
                        let noise: Vec<u8> = pending.drain(..start).collect();
                        log::info!(
                            "[recording-card] skip {} bytes before {command}: {:?}",
                            noise.len(),
                            preview_text(&noise)
                        );
                    }
                    if let Some(end) = find_nth_hash(&pending, marker.len(), min_fields) {
                        let frame: Vec<u8> = pending.drain(..=end).collect();
                        let text = decode_frame_text(&frame);
                        log::info!(
                            "[recording-card] recv text cmd={} bytes={} text={:?}",
                            command,
                            frame.len(),
                            text.chars().take(MAX_LOG_CHARS).collect::<String>()
                        );
                        return parse_response(&frame, response_prefix()).ok_or_else(|| {
                            DeviceError::Transfer(format!("malformed {command} response"))
                        });
                    }
                } else if let Some(noise) = discard_prefix_noise(&mut pending) {
                    log::info!(
                        "[recording-card] discard {} bytes waiting for {command}: {:?}",
                        noise.len(),
                        preview_text(&noise)
                    );
                }
            }

            if tokio::time::Instant::now() >= deadline {
                break;
            }
            match self.read_frame().await {
                Ok(raw) => {
                    reads += 1;
                    let mut pending = self.pending.lock().await;
                    pending.extend_from_slice(&raw);
                }
                Err(error) => {
                    log::debug!(
                        "[recording-card] read timeout waiting for {command}: {error}"
                    );
                }
            }
        }

        let preview = {
            let pending = self.pending.lock().await;
            preview_text(&pending)
        };
        log::warn!(
            "[recording-card] timeout waiting for {command} after {reads} reads; pending={:?}",
            preview
        );
        Err(DeviceError::Transfer(format!(
            "no response for command {command}"
        )))
    }

    /// Read one payload frame such as
    /// `*DEV#listreq#<i>#<len>#<crc>#<payload>` or
    /// `*DEV#filect#<sn>#<total>#<i>#<len>#<crc>#<payload>`.
    /// `length_index` tells which `#` field carries the payload byte count.
    /// The SDK's file-list and download paths do not validate the CRC field,
    /// so neither do we; the declared payload length is enforced instead.
    pub async fn read_payload_frame(
        &self,
        command: &str,
        length_index: usize,
        timeout: Duration,
    ) -> Result<PayloadFrame, DeviceError> {
        let marker = frame_marker(response_prefix(), command);
        let deadline = tokio::time::Instant::now() + timeout;
        let mut reads = 0usize;

        loop {
            {
                let mut pending = self.pending.lock().await;

                if let Some(start) = find_subslice(&pending, &marker) {
                    if start > 0 {
                        let noise: Vec<u8> = pending.drain(..start).collect();
                        log::info!(
                            "[recording-card] skip {} bytes before {command} payload: {:?}",
                            noise.len(),
                            preview_text(&noise)
                        );
                    }
                    if let Some((header_end, parts, payload_len)) =
                        parse_payload_header(&pending, &marker, length_index)
                    {
                        let total = header_end
                            .checked_add(1)
                            .and_then(|value| value.checked_add(payload_len))
                            .ok_or_else(|| {
                                DeviceError::Transfer(format!(
                                    "invalid {command} payload length"
                                ))
                            })?;
                        if pending.len() >= total {
                            let payload = pending[header_end + 1..total].to_vec();
                            pending.drain(..total);
                            log::info!(
                                "[recording-card] recv payload cmd={} parts={:?} bytes={}",
                                command,
                                parts,
                                payload.len()
                            );
                            return Ok(PayloadFrame { parts, payload });
                        }
                    }
                } else if let Some(noise) = discard_prefix_noise(&mut pending) {
                    log::info!(
                        "[recording-card] discard {} bytes waiting for {command} payload: {:?}",
                        noise.len(),
                        preview_text(&noise)
                    );
                }
            }

            if tokio::time::Instant::now() >= deadline {
                break;
            }
            match self.read_frame().await {
                Ok(raw) => {
                    reads += 1;
                    let mut pending = self.pending.lock().await;
                    pending.extend_from_slice(&raw);
                }
                Err(error) => {
                    log::debug!(
                        "[recording-card] read timeout waiting for {command} payload: {error}"
                    );
                }
            }
        }

        let preview = {
            let pending = self.pending.lock().await;
            preview_text(&pending)
        };
        log::warn!(
            "[recording-card] timeout waiting for {command} payload after {reads} reads; pending={:?}",
            preview
        );
        Err(DeviceError::Transfer(format!(
            "no payload for command {command}"
        )))
    }
}

fn frame_marker(prefix: &str, command: &str) -> Vec<u8> {
    format!("{prefix}#{command}#").into_bytes()
}

fn preview_text(bytes: &[u8]) -> String {
    decode_frame_text(bytes)
        .chars()
        .take(MAX_LOG_CHARS)
        .collect()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn find_nth_hash(buf: &[u8], start: usize, n: usize) -> Option<usize> {
    if n == 0 {
        return None;
    }
    let mut count = 0usize;
    for (index, byte) in buf.iter().enumerate().skip(start) {
        if *byte == b'#' {
            count += 1;
            if count == n {
                return Some(index);
            }
        }
    }
    None
}

/// Parse a payload-frame header without touching the payload bytes. Binary
/// payloads contain NULs and `#` bytes, so the whole buffer must never go
/// through `strip_nulls` or text-frame parsing.
fn parse_payload_header(
    pending: &[u8],
    marker: &[u8],
    length_index: usize,
) -> Option<(usize, Vec<String>, usize)> {
    let start = find_subslice(pending, marker)?;
    let header_end = find_nth_hash(pending, start + marker.len(), length_index)?;
    let header_text = decode_frame_text(&pending[..=header_end]);
    let parts: Vec<String> = split_frame(&header_text)
        .into_iter()
        .map(str::to_string)
        .collect();
    let payload_len = parts.get(length_index)?.parse::<usize>().ok()?;
    Some((header_end, parts, payload_len))
}

fn strip_nulls(buf: &mut Vec<u8>) {
    buf.retain(|&byte| byte != 0);
}

/// Discard bytes that cannot start the expected `*DEV#` marker, keeping the
/// last potential `*` so a marker split across bulk reads is not lost.
fn discard_prefix_noise(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    let keep = buf
        .iter()
        .rposition(|&byte| byte == b'*')
        .unwrap_or(buf.len());
    if keep == 0 {
        return None;
    }
    Some(buf.drain(..keep).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_header_preserves_binary_payload() {
        // Real Opus packets contain NUL bytes and can contain `#`; neither may
        // be stripped or treated as a frame delimiter.
        let payload = [0u8, 1, b'#', 0, 255];
        let mut frame = b"*DEV#filect#162#1#1#5#0#".to_vec();
        frame.extend_from_slice(&payload);

        let (header_end, parts, payload_len) =
            parse_payload_header(&frame, b"*DEV#filect#", 5).expect("parse header");
        assert_eq!(parts[5], "5");
        assert_eq!(payload_len, payload.len());
        assert_eq!(&frame[header_end + 1..header_end + 1 + payload_len], &payload);
    }
}
