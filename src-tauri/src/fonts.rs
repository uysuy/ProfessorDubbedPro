//! Enumerate installed system fonts for subtitle style picker / export.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontInfo {
	/// Family name used in CSS / ASS `Fontname`.
	pub family: String,
	/// Absolute path to a TTF/OTF file.
	pub path: String,
}

fn fonts_dirs() -> Vec<PathBuf> {
	let mut dirs = Vec::new();
	#[cfg(windows)]
	{
		dirs.push(PathBuf::from(r"C:\Windows\Fonts"));
		if let Ok(local) = std::env::var("LOCALAPPDATA") {
			dirs.push(PathBuf::from(local).join(r"Microsoft\Windows\Fonts"));
		}
	}
	#[cfg(target_os = "macos")]
	{
		dirs.push(PathBuf::from("/Library/Fonts"));
		dirs.push(PathBuf::from("/System/Library/Fonts"));
		if let Ok(home) = std::env::var("HOME") {
			dirs.push(PathBuf::from(home).join("Library/Fonts"));
		}
	}
	#[cfg(target_os = "linux")]
	{
		dirs.push(PathBuf::from("/usr/share/fonts"));
		dirs.push(PathBuf::from("/usr/local/share/fonts"));
		if let Ok(home) = std::env::var("HOME") {
			dirs.push(PathBuf::from(&home).join(".fonts"));
			dirs.push(PathBuf::from(&home).join(".local/share/fonts"));
		}
	}
	dirs
}

fn is_font_file(path: &Path) -> bool {
	match path
		.extension()
		.and_then(|e| e.to_str())
		.map(|e| e.to_ascii_lowercase())
	{
		Some(ext) => matches!(ext.as_str(), "ttf" | "otf" | "ttc"),
		None => false,
	}
}

/// Guess a display family from the filename (good enough for picker + ASS).
fn family_from_filename(path: &Path) -> String {
	let stem = path
		.file_stem()
		.and_then(|s| s.to_str())
		.unwrap_or("Font")
		.trim();
	// Strip common weight/style suffixes for cleaner family names.
	let stripped = stem
		.trim_end_matches("-Regular")
		.trim_end_matches("-Bold")
		.trim_end_matches("-Light")
		.trim_end_matches("-Medium")
		.trim_end_matches("-SemiBold")
		.trim_end_matches(" Regular")
		.trim_end_matches(" Bold")
		.trim_end_matches("Bold")
		.trim_end_matches("Reg");
	// KhmerUI.ttf → Khmer UI; KhmerOS.ttf → Khmer OS
	let spaced = stripped
		.replace("KhmerUI", "Khmer UI")
		.replace("KhmerOS", "Khmer OS")
		.replace("NotoSansKhmer", "Noto Sans Khmer")
		.replace("LeelawadeeUI", "Leelawadee UI")
		.replace("LeelawUI", "Leelawadee UI")
		.replace("LEELAWAD", "Leelawadee")
		.replace("DaunPenh", "DaunPenh");
	if spaced.contains(' ') || spaced.chars().any(|c| c.is_lowercase()) {
		return spaced.to_string();
	}
	// CamelCase → spaced words for nicer UI.
	let mut out = String::new();
	for (i, ch) in spaced.chars().enumerate() {
		if i > 0 && ch.is_uppercase() {
			out.push(' ');
		}
		out.push(ch);
	}
	if out.is_empty() {
		stem.to_string()
	} else {
		out
	}
}

fn score_regular(path: &Path) -> i32 {
	let name = path
		.file_name()
		.and_then(|s| s.to_str())
		.unwrap_or("")
		.to_ascii_lowercase();
	let mut score = 0;
	if name.contains("regular") || name.ends_with("reg.ttf") {
		score += 10;
	}
	if name.contains("bold") || name.contains("black") || name.contains("heavy") {
		score -= 5;
	}
	if name.contains("italic") || name.contains("oblique") {
		score -= 3;
	}
	if name.contains("light") || name.contains("thin") {
		score -= 2;
	}
	// Prefer .ttf over .ttc for libass.
	if name.ends_with(".ttf") || name.ends_with(".otf") {
		score += 2;
	}
	if name.ends_with(".ttc") {
		score -= 4;
	}
	score
}

fn collect_fonts_in_dir(dir: &Path, into: &mut BTreeMap<String, (i32, PathBuf)>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			// Shallow recurse one level for Linux font packages.
			collect_fonts_in_dir(&path, into);
			continue;
		}
		if !is_font_file(&path) {
			continue;
		}
		let family = family_from_filename(&path);
		if family.is_empty() {
			continue;
		}
		let score = score_regular(&path);
		match into.get(&family) {
			Some((prev, _)) if *prev >= score => {}
			_ => {
				into.insert(family, (score, path));
			}
		}
	}
}

/// List installed fonts (deduped by family, prefer Regular TTF).
#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<SystemFontInfo>, String> {
	let mut map: BTreeMap<String, (i32, PathBuf)> = BTreeMap::new();
	for dir in fonts_dirs() {
		if dir.is_dir() {
			collect_fonts_in_dir(&dir, &mut map);
		}
	}

	// Ensure bundled Noto appears even if not installed system-wide.
	let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("resources/fonts/NotoSansKhmer-Regular.ttf");
	if bundled.is_file() {
		map.entry("Noto Sans Khmer".into())
			.or_insert_with(|| (100, bundled));
	}

	let mut out: Vec<SystemFontInfo> = map
		.into_iter()
		.map(|(family, (_score, path))| SystemFontInfo {
			family,
			path: path.to_string_lossy().to_string(),
		})
		.collect();
	out.sort_by(|a, b| a.family.to_lowercase().cmp(&b.family.to_lowercase()));
	Ok(out)
}

fn decode_utf16_be(raw: &[u8]) -> Option<String> {
	if raw.len() < 2 || raw.len() % 2 != 0 {
		return None;
	}
	let units: Vec<u16> = raw
		.chunks_exact(2)
		.map(|c| u16::from_be_bytes([c[0], c[1]]))
		.collect();
	String::from_utf16(&units).ok()
}

/// Read OpenType/TrueType name table family (for ASS `Fontname`).
pub fn read_font_family_name(path: &Path) -> Option<String> {
	let data = fs::read(path).ok()?;
	if data.starts_with(b"ttcf") {
		// Collection — skip for now; caller should prefer .ttf/.otf.
		return None;
	}
	if data.len() < 12 {
		return None;
	}
	let num_tables = u16::from_be_bytes([data[4], data[5]]) as usize;
	let mut name_off = None;
	let mut name_len = None;
	for i in 0..num_tables {
		let o = 12 + i * 16;
		if o + 16 > data.len() {
			break;
		}
		if &data[o..o + 4] != b"name" {
			continue;
		}
		name_off = Some(u32::from_be_bytes(data[o + 8..o + 12].try_into().ok()?) as usize);
		name_len = Some(u32::from_be_bytes(data[o + 12..o + 16].try_into().ok()?) as usize);
		break;
	}
	let name_off = name_off?;
	let name_len = name_len?;
	if name_off + 6 > data.len() {
		return None;
	}
	let end = (name_off + name_len).min(data.len());
	let name = &data[name_off..end];
	let count = u16::from_be_bytes([name[2], name[3]]) as usize;
	let string_offset = u16::from_be_bytes([name[4], name[5]]) as usize;

	let mut best: Option<(i32, String)> = None;
	for i in 0..count {
		let r = 6 + i * 12;
		if r + 12 > name.len() {
			break;
		}
		let platform = u16::from_be_bytes([name[r], name[r + 1]]);
		let language = u16::from_be_bytes([name[r + 4], name[r + 5]]);
		let name_id = u16::from_be_bytes([name[r + 6], name[r + 7]]);
		let length = u16::from_be_bytes([name[r + 8], name[r + 9]]) as usize;
		let offset = u16::from_be_bytes([name[r + 10], name[r + 11]]) as usize;
		// 16 = Typographic Family, 1 = Font Family
		if name_id != 1 && name_id != 16 {
			continue;
		}
		let so = string_offset + offset;
		if so + length > name.len() {
			continue;
		}
		let raw = &name[so..so + length];
		let s = if platform == 3 || platform == 0 {
			decode_utf16_be(raw)?
		} else if platform == 1 {
			String::from_utf8_lossy(raw).trim().to_string()
		} else {
			continue;
		};
		let s = s.trim().to_string();
		if s.is_empty() {
			continue;
		}
		let mut score = if name_id == 16 { 20 } else { 10 };
		if platform == 3 {
			score += 2;
		}
		if language == 0x0409 {
			score += 5;
		}
		if best.as_ref().map(|(sc, _)| score > *sc).unwrap_or(true) {
			best = Some((score, s));
		}
	}
	best.map(|(_, s)| s)
}

/// Find a TTF/OTF on disk for a picker family name (when `fontFile` is missing).
pub fn find_system_font_path(family: &str) -> Option<PathBuf> {
	let want = family.trim().to_ascii_lowercase();
	if want.is_empty() {
		return None;
	}
	let mut map: BTreeMap<String, (i32, PathBuf)> = BTreeMap::new();
	for dir in fonts_dirs() {
		if dir.is_dir() {
			collect_fonts_in_dir(&dir, &mut map);
		}
	}
	let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("resources/fonts/NotoSansKhmer-Regular.ttf");
	if bundled.is_file() {
		map.entry("Noto Sans Khmer".into())
			.or_insert_with(|| (100, bundled));
	}
	// Exact family match first, then contains.
	if let Some((_, path)) = map.get(family.trim()) {
		return Some(path.clone());
	}
	for (fam, (_score, path)) in &map {
		if fam.to_ascii_lowercase() == want {
			return Some(path.clone());
		}
	}
	for (fam, (_score, path)) in &map {
		if fam.to_ascii_lowercase().contains(&want) || want.contains(&fam.to_ascii_lowercase()) {
			let ext = path
				.extension()
				.and_then(|e| e.to_str())
				.map(|e| e.to_ascii_lowercase())
				.unwrap_or_default();
			if matches!(ext.as_str(), "ttf" | "otf") {
				return Some(path.clone());
			}
		}
	}
	None
}
