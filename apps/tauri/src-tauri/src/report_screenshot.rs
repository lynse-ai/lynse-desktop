//! Main-window screenshot capture for the problem report.
//!
//! The report window is a separate webview, so the renderer cannot photograph
//! the app itself — the capture runs here, on the window the user was just
//! looking at. The JPEG is staged through the same inspiration staging
//! pipeline as pasted screenshots, so previews (`local-media://`) and issue
//! attachment both flow through one uniform path.
//!
//! Annotations (pen strokes / arrows the user draws over the capture) are
//! composited here as well: the renderer only ships its transparent overlay,
//! never the base pixels (see [`report_save_annotated_screenshot`]).

use crate::{write_staged_image, CommandResult};
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;

/// Snapshot budget, including the blocking Windows capture operation.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(6);

/// Upper bound for the renderer's annotation overlay. A mostly transparent
/// PNG the size of the screenshot compresses to a few hundred KB at most.
const MAX_OVERLAY_BYTES: usize = 8 * 1024 * 1024;

/// Snapshot the main window's content as a JPEG and stage it, returning
/// `{path, url}` where `url` is a `local-media://` preview link. Always
/// targets the `main` window — safe to call from the report window while it
/// sits in front.
///
/// `background` is an `rgb(r g b)` string resolved from the renderer's
/// `--background` token. The vibrancy shell keeps the title bar, sidebar and
/// window edge transparent, so the snapshot carries alpha there; JPEG has
/// none, and AppKit would flatten those pixels to white — a light border
/// around dark-theme captures. They are flattened onto this color instead.
#[tauri::command(async)]
pub async fn report_capture_main_screenshot(
    app: AppHandle,
    background: Option<String>,
) -> CommandResult<Value> {
    if crate::inspiration_private::has_unlocked(&app) { return Err("private_content_screenshot_disabled".into()); }
    let (tx, rx) = std::sync::mpsc::channel();
    #[cfg(target_os = "macos")]
    {
        let initiator = app.clone();
        let error_tx = tx.clone();
        app.run_on_main_thread(move || {
            // Must not block here: the WKWebView completion handler fires on
            // the main runloop, so initiating is all this closure may do.
            if let Err(error) = initiate_main_window_snapshot(&initiator, background, tx) {
                log::warn!("[report-screenshot] initiation failed: {error}");
                let _ = error_tx.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        let handle = app.clone();
        // PrintWindow can block. Start the receiver's timeout independently
        // so a stalled capture does not leave the report flow waiting forever.
        tauri::async_runtime::spawn_blocking(move || {
            let capture = capture_main_window_jpeg(&handle);
            let _ = tx.send(capture);
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = tx.send(Err("screenshot capture is not supported on this platform".into()));
    }

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = rx
            .recv_timeout(SNAPSHOT_TIMEOUT)
            .map_err(|_| "screenshot capture timed out".to_owned())??;
        write_staged_image(&handle, bytes, "report", "jpg")
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Burn the renderer's annotation overlay (transparent PNG, base64) into the
/// staged screenshot and stage the result as a fresh JPEG, returning the new
/// `{path, url}`. The renderer never reads the base image's pixels — a
/// `local-media://` source would taint its canvas — so only the small overlay
/// crosses the IPC and the compositing happens here, off the main thread.
#[tauri::command(async)]
pub async fn report_save_annotated_screenshot(
    app: AppHandle,
    path: String,
    overlay: String,
) -> CommandResult<Value> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;

        let overlay = base64::engine::general_purpose::STANDARD
            .decode(overlay.as_bytes())
            .map_err(|error| format!("annotation overlay is not valid base64: {error}"))?;
        if overlay.is_empty() || overlay.len() > MAX_OVERLAY_BYTES {
            return Err("annotation overlay size out of range".into());
        }
        // The read refuses anything outside the staging folder.
        let base = crate::cnb_report::read_staged_screenshot(&handle, &path)?;
        let composed = composite_annotation(&base, &overlay)?;
        let staged = write_staged_image(&handle, composed, "report", "jpg")?;
        // Staging only ever holds the latest version of the capture.
        if is_report_capture_file(&path) {
            let _ = std::fs::remove_file(&path);
        }
        Ok(staged)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Only the capture command's own `report-*.jpg` files are ever replaced —
/// never a pasted inspiration image that happens to share the staging dir.
fn is_report_capture_file(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("report-") && name.ends_with(".jpg"))
}

/// Alpha-blend the overlay onto the base capture and re-encode as JPEG. A
/// mismatched overlay is resized rather than rejected so the annotation
/// geometry stays put even if the renderer's canvas rounding drifts a pixel.
fn composite_annotation(base_jpeg: &[u8], overlay_png: &[u8]) -> CommandResult<Vec<u8>> {
    use std::io::Cursor;

    let mut canvas = image::load_from_memory_with_format(base_jpeg, image::ImageFormat::Jpeg)
        .map_err(|error| format!("screenshot decoding failed: {error}"))?
        .to_rgba8();
    let overlay = image::load_from_memory_with_format(overlay_png, image::ImageFormat::Png)
        .map_err(|error| format!("annotation overlay decoding failed: {error}"))?
        .to_rgba8();
    let overlay = if overlay.dimensions() == canvas.dimensions() {
        overlay
    } else {
        image::imageops::resize(
            &overlay,
            canvas.width(),
            canvas.height(),
            image::imageops::FilterType::Triangle,
        )
    };
    image::imageops::overlay(&mut canvas, &overlay, 0, 0);

    // A notch above the capture's quality 85: strokes are thin, high-contrast
    // edges that JPEG ringing would smear.
    let rgb = image::DynamicImage::ImageRgba8(canvas).to_rgb8();
    let mut jpeg = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 88);
    rgb.write_with_encoder(encoder)
        .map_err(|error| format!("annotated screenshot JPEG encoding failed: {error}"))?;
    Ok(jpeg.into_inner())
}

/// Encode an AppKit image snapshot into JPEG bytes. UI captures compress
/// ~10× smaller as JPEG than PNG, and the report flow values upload size
/// over pixel-perfect fidelity. Snapshot pixels the page left transparent
/// (vibrancy regions) are flattened onto `background` first — see
/// [`flatten_rep_to_jpeg`].
#[cfg(target_os = "macos")]
fn jpeg_bytes_from_image(
    image: &objc2_app_kit::NSImage,
    background: Option<&str>,
) -> CommandResult<Vec<u8>> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey,
        NSImageCompressionFactor,
    };
    use objc2_foundation::{NSDictionary, NSNumber};

    let Some(tiff) = image.TIFFRepresentation() else {
        return Err("snapshot TIFF encoding failed".into());
    };
    let Some(rep) = NSBitmapImageRep::imageRepWithData(&tiff) else {
        return Err("snapshot bitmap decoding failed".into());
    };
    if let Some(jpeg) = flatten_rep_to_jpeg(&rep, background)? {
        return Ok(jpeg);
    }
    let quality = NSNumber::new_f64(0.85);
    // The properties dictionary is untyped (`AnyObject` values), so bridge
    // the retained NSNumber through a raw cast.
    let quality_ref = unsafe { &*(&*quality as *const NSNumber as *const AnyObject) };
    let properties = unsafe {
        // Reading the `NSImageCompressionFactor` extern static is unsafe too.
        NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::from_slices(
            &[NSImageCompressionFactor],
            &[quality_ref],
        )
    };
    let jpeg = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties) };
    let Some(jpeg) = jpeg else {
        return Err("snapshot JPEG encoding failed".into());
    };
    Ok(jpeg.to_vec())
}

/// Flatten an 8-bit RGBA bitmap rep over `background` and JPEG-encode it.
/// Returns `Ok(None)` when the rep isn't RGBA8 (the caller falls back to
/// AppKit's own JPEG encoder). Snapshot alpha exists wherever the page lets
/// the native vibrancy show through — title bar, sidebar, window edge — and
/// AppKit's JPEG encoding flattens it to white, which reads as a light
/// border around dark-theme captures.
#[cfg(target_os = "macos")]
fn flatten_rep_to_jpeg(
    rep: &objc2_app_kit::NSBitmapImageRep,
    background: Option<&str>,
) -> CommandResult<Option<Vec<u8>>> {
    use std::io::Cursor;

    // `pixelsWide`/`pixelsHigh`/`bitsPerSample` live on the NSImageRep
    // superclass; the bitmap buffer accessors are on NSBitmapImageRep.
    let samples = rep.samplesPerPixel();
    if rep.bitsPerSample() != 8 || samples != 4 || rep.isPlanar() {
        return Ok(None);
    }
    let width = rep.pixelsWide().max(0) as u32;
    let height = rep.pixelsHigh().max(0) as u32;
    if width == 0 || height == 0 {
        return Ok(None);
    }
    let data = rep.bitmapData();
    if data.is_null() {
        return Ok(None);
    }
    let stride = rep.bytesPerRow().max(0) as usize;
    if stride < width as usize * 4 {
        return Ok(None);
    }
    let raw = unsafe { std::slice::from_raw_parts(data, stride * height as usize) };
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for row in 0..height as usize {
        let start = row * stride;
        rgba.extend_from_slice(&raw[start..start + width as usize * 4]);
    }
    flatten_premultiplied_rgba_over(&mut rgba, background);

    let frame = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or("snapshot frame decoding failed")?;
    let rgb = image::DynamicImage::ImageRgba8(frame).to_rgb8();
    let mut jpeg = Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85);
    rgb.write_with_encoder(encoder)
        .map_err(|error| format!("screenshot JPEG encoding failed: {error}"))?;
    Ok(Some(jpeg.into_inner()))
}

/// Parse an `rgb(r g b)` string (what the renderer sends for its resolved
/// `--background` token). Falls back to white — AppKit's own flattening
/// color — when the value is missing or malformed.
#[cfg(any(target_os = "macos", test))]
fn parse_rgb(value: Option<&str>) -> [u8; 3] {
    let Some(value) = value else {
        return [255, 255, 255];
    };
    let mut channels = [255u8; 3];
    let mut found = 0;
    for part in value.split(|c: char| !c.is_ascii_digit()) {
        if part.is_empty() {
            continue;
        }
        let Some(byte) = part.parse::<u8>().ok().filter(|_| found < 3) else {
            return [255, 255, 255];
        };
        channels[found] = byte;
        found += 1;
    }
    if found == 3 { channels } else { [255, 255, 255] }
}

/// Alpha-composite premultiplied RGBA over `background`, in place. Snapshot
/// alpha is premultiplied, so `out = fg + bg·(1−a)`; opaque pixels are left
/// untouched. (No-op alpha handling for the non-macOS captures: Windows'
/// PrintWindow DIB carries no meaningful alpha.)
#[cfg(any(target_os = "macos", test))]
fn flatten_premultiplied_rgba_over(rgba: &mut [u8], background: Option<&str>) {
    let bg = parse_rgb(background);
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = pixel[3] as u16;
        if alpha == 255 {
            continue;
        }
        for (channel, base) in pixel[..3].iter_mut().zip(bg) {
            let fg = *channel as u16;
            *channel = ((fg + (base as u16 * (255 - alpha)) / 255).min(255)) as u8;
        }
        *pixel.last_mut().expect("RGBA pixel has alpha") = 255;
    }
}

/// Kick off a `WKWebView.takeSnapshot` for the main window, delivering JPEG
/// bytes (or the error) through `tx` once the completion handler runs on the
/// main runloop. Returns before the snapshot exists.
#[cfg(target_os = "macos")]
fn initiate_main_window_snapshot(
    app: &AppHandle,
    background: Option<String>,
    tx: std::sync::mpsc::Sender<CommandResult<Vec<u8>>>,
) -> CommandResult<()> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindow;
    use std::ptr;
    // `get_webview_window` lives on the Manager trait.
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())?;
    if ns_window_ptr.is_null() {
        return Err("main window has no native handle".into());
    }
    let ns_window = unsafe { &*(ns_window_ptr.cast::<NSWindow>()) };
    let Some(content) = ns_window.contentView() else {
        return Err("main window has no content view".into());
    };
    let Some(webview) = find_wk_webview(&content) else {
        return Err("main window webview not found".into());
    };

    // The completion block receives (NSImage snapshot, NSError error) — two
    // object pointers, matched by raw pointers to avoid dragging NSError into
    // the feature set.
    let block = block2::RcBlock::new(move |snapshot: *mut AnyObject, _error: *mut AnyObject| {
        let result = if snapshot.is_null() {
            Err("webview snapshot failed".to_owned())
        } else {
            jpeg_bytes_from_image(
                unsafe { &*(snapshot.cast::<objc2_app_kit::NSImage>()) },
                background.as_deref(),
            )
        };
        let _ = tx.send(result);
    });
    unsafe {
        let _: () = objc2::msg_send![
            webview,
            takeSnapshotWithConfiguration: ptr::null_mut::<AnyObject>(),
            completionHandler: &*block
        ];
    }
    Ok(())
}

/// Depth-first search of the view hierarchy for the WKWebView that hosts the
/// window's page content (wry nests it below the content view).
#[cfg(target_os = "macos")]
fn find_wk_webview(view: &objc2_app_kit::NSView) -> Option<*mut objc2::runtime::AnyObject> {
    use objc2_foundation::NSObjectProtocol;

    let webview_class = objc2::class!(WKWebView);
    if view.isKindOfClass(webview_class) {
        let pointer: *const objc2_app_kit::NSView = view;
        return Some(pointer.cast_mut().cast::<objc2::runtime::AnyObject>());
    }
    for subview in view.subviews().iter() {
        if let Some(found) = find_wk_webview(&subview) {
            return Some(found);
        }
    }
    None
}

/// Windows capture: `PrintWindow` with `PW_RENDERFULLCONTENT` renders the
/// client area into a memory DC. GDI hands us BGRA pixels to encode as JPEG.
#[cfg(target_os = "windows")]
fn capture_main_window_jpeg(app: &AppHandle) -> CommandResult<Vec<u8>> {
    use std::io::Cursor;

    use tauri::Manager;
    use windows::Win32::Foundation::RECT;
    // windows-rs files PrintWindow under Storage::Xps (user32 metadata
    // quirk), but keeps PW_RENDERFULLCONTENT in WindowsAndMessaging as a
    // bare u32.
    use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PW_CLIENTONLY, PrintWindow};
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetWindowDC, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, PW_RENDERFULLCONTENT};

    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;

    unsafe {
        let mut rect = RECT::default();
        GetClientRect(hwnd, &mut rect)
            .map_err(|error| format!("main window rect unavailable: {error}"))?;
        let width = (rect.right - rect.left).max(0);
        let height = (rect.bottom - rect.top).max(0);
        if width == 0 || height == 0 {
            return Err("main window has no visible content".into());
        }

        let hdc_window = GetWindowDC(Some(hwnd));
        if hdc_window.is_invalid() {
            return Err("main window device context unavailable".into());
        }
        let hdc_memory = CreateCompatibleDC(Some(hdc_window));
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                // Negative height = top-down rows, matching the encoder's row order.
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(Some(hdc_memory), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|error| format!("capture bitmap allocation failed: {error}"));
        if let Err(error) = dib {
            let _ = DeleteDC(hdc_memory);
            let _ = ReleaseDC(Some(hwnd), hdc_window);
            return Err(error);
        }
        let dib = dib.unwrap();
        let previous = SelectObject(hdc_memory, dib.into());

        let flags = PRINT_WINDOW_FLAGS(PW_CLIENTONLY.0 | PW_RENDERFULLCONTENT);
        let printed = PrintWindow(hwnd, hdc_memory, flags).as_bool();
        let mut result: CommandResult<Vec<u8>> = if printed {
            let stride = width as usize * 4;
            let raw =
                std::slice::from_raw_parts(bits as *const u8, stride * height as usize);
            let mut rgba = raw.to_vec();
            for pixel in rgba.chunks_exact_mut(4) {
                pixel.swap(0, 2); // BGRA → RGBA
            }
            match image::RgbaImage::from_raw(width as u32, height as u32, rgba) {
                Some(frame) => {
                    // JPEG at quality 85: UI captures compress ~10× smaller
                    // than PNG, keeping the report upload lightweight.
                    let rgb = image::DynamicImage::ImageRgba8(frame).to_rgb8();
                    let mut jpeg = Cursor::new(Vec::new());
                    let mut encoder =
                        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85);
                    rgb.write_with_encoder(encoder)
                        .map_err(|error| format!("screenshot JPEG encoding failed: {error}"))?;
                    Ok(jpeg.into_inner())
                }
                None => Err("screenshot frame decoding failed".into()),
            }
        } else {
            Err("PrintWindow failed for the main window".into())
        };

        SelectObject(hdc_memory, previous);
        let _ = DeleteObject(dib.into());
        let _ = DeleteDC(hdc_memory);
        let _ = ReleaseDC(Some(hwnd), hdc_window);
        result
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture_main_window_jpeg(_app: &AppHandle) -> CommandResult<Vec<u8>> {
    Err("screenshot capture is not supported on this platform".into())
}

/// Stage an image the user picked from disk (renderer-side file dialog) as a
/// report attachment: copied into the plain staging dir under the `report-`
/// prefix, so it never takes the private-vault branch in
/// [`crate::write_staged_image`] (that store is for inspiration content, not
/// report uploads) and is wiped on next launch like every staged capture.
/// Returns `{path, url}` with the `local-media://` preview link.
#[tauri::command(async)]
pub fn report_stage_attachment(app: AppHandle, path: String) -> CommandResult<Value> {
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err("Attachment file is empty".into());
    }
    let extension = std::path::Path::new(&path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| crate::is_safe_asset_file_name(value))
        .unwrap_or_else(|| crate::sniff_image_extension(&bytes).to_owned());
    crate::write_staged_image(&app, bytes, "report", &extension)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const RED: image::Rgba<u8> = image::Rgba([255, 0, 0, 255]);
    const BLUE: image::Rgba<u8> = image::Rgba([0, 0, 255, 255]);
    const CLEAR: image::Rgba<u8> = image::Rgba([0, 0, 0, 0]);

    fn encode(image: image::RgbaImage, format: image::ImageFormat) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut buffer, format)
            .expect("fixture encodes");
        buffer.into_inner()
    }

    /// Transparent overlay with the left half painted — wide enough that JPEG
    /// chroma subsampling cannot bleed the neighbouring colour into the probes.
    fn half_painted_overlay(size: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(size, size, |x, _| if x < size / 2 { BLUE } else { CLEAR })
    }

    fn decode(jpeg: &[u8]) -> image::RgbImage {
        image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg)
            .expect("composite decodes")
            .to_rgb8()
    }

    #[test]
    fn composite_blends_overlay_strokes_onto_the_capture() {
        let base = encode(image::RgbaImage::from_pixel(16, 16, RED), image::ImageFormat::Jpeg);
        let overlay = encode(half_painted_overlay(16), image::ImageFormat::Png);

        let out = decode(&composite_annotation(&base, &overlay).expect("composite succeeds"));
        let marked = out.get_pixel(2, 2);
        let untouched = out.get_pixel(13, 13);
        assert!(marked[2] > marked[0], "stroke pixel should read blue, got {marked:?}");
        assert!(untouched[0] > untouched[2], "clear pixel should stay red, got {untouched:?}");
    }

    #[test]
    fn composite_resizes_a_mismatched_overlay_instead_of_failing() {
        let base = encode(image::RgbaImage::from_pixel(16, 16, RED), image::ImageFormat::Jpeg);
        let overlay = encode(half_painted_overlay(8), image::ImageFormat::Png);

        let out = decode(&composite_annotation(&base, &overlay).expect("composite succeeds"));
        assert!(out.get_pixel(2, 2)[2] > out.get_pixel(2, 2)[0]);
        assert!(out.get_pixel(13, 13)[0] > out.get_pixel(13, 13)[2]);
    }

    #[test]
    fn composite_rejects_garbage_inputs() {
        let base = encode(image::RgbaImage::from_pixel(4, 4, RED), image::ImageFormat::Jpeg);
        assert!(composite_annotation(b"not a jpeg", &[]).is_err());
        assert!(composite_annotation(&base, b"not a png").is_err());
    }

    #[test]
    fn only_report_captures_are_replaced() {
        assert!(is_report_capture_file("/data/inspirations/staging/report-abc.jpg"));
        assert!(!is_report_capture_file("/data/inspirations/staging/paste-abc.jpg"));
        assert!(!is_report_capture_file("/data/inspirations/staging/report-abc.png"));
        assert!(!is_report_capture_file(""));
    }

    #[test]
    fn rgb_strings_parse_and_fall_back_to_white() {
        assert_eq!(parse_rgb(Some("rgb(24 24 24)")), [24, 24, 24]);
        assert_eq!(parse_rgb(Some("rgb(0, 128, 255)")), [0, 128, 255]);
        assert_eq!(parse_rgb(Some("rgb(1 2 3 / 1)")), [255, 255, 255]); // alpha form: reject
        assert_eq!(parse_rgb(Some("rgb(1 2)")), [255, 255, 255]);
        assert_eq!(parse_rgb(Some("rgb(x y z)")), [255, 255, 255]);
        assert_eq!(parse_rgb(None), [255, 255, 255]);
    }

    #[test]
    fn transparent_pixels_flatten_onto_the_theme_background() {
        // Fully transparent → background; semi-transparent → blend;
        // opaque → untouched; alpha channel becomes opaque.
        let mut rgba = [
            0, 0, 0, 0, // transparent → bg
            100, 0, 0, 128, // premultiplied half red over dark bg
            200, 150, 100, 255, // opaque → untouched
        ];
        flatten_premultiplied_rgba_over(&mut rgba, Some("rgb(24 26 28)"));
        assert_eq!(&rgba[0..4], &[24, 26, 28, 255]);
        // fg=100,a=128 over 24: 100 + 24·127/255 ≈ 111
        assert_eq!(rgba[4], ((100 + (24 * 127) / 255) as u16).min(255) as u8);
        assert_eq!(&rgba[8..12], &[200, 150, 100, 255]);
    }

    #[test]
    fn missing_background_flattens_to_white_like_appkit() {
        let mut rgba = [0, 0, 0, 0, 0, 0, 0, 255];
        flatten_premultiplied_rgba_over(&mut rgba, None);
        assert_eq!(&rgba[0..4], &[255, 255, 255, 255]);
        assert_eq!(&rgba[4..8], &[0, 0, 0, 255]);
    }
}
