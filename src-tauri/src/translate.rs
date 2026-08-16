//! Machine translation: Azure Translator when a key is provided, else Google Translate (gtx).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::thread;
use std::time::Duration;

const AZURE_BATCH: usize = 50;
const GOOGLE_DELAY_MS: u64 = 40;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextsArgs {
	pub texts: Vec<String>,
	/// Source language hint, e.g. `zh`, `zh-Hans`, `zh-CN`. Empty = auto/zh-Hans.
	#[serde(default)]
	pub from: String,
	/// Target language, e.g. `km`.
	#[serde(default = "default_to")]
	pub to: String,
	/// Azure Translator subscription key. When set, Azure is preferred.
	#[serde(default)]
	pub azure_key: String,
	/// Azure region (e.g. `eastasia`). Empty / `global` omits the region header.
	#[serde(default)]
	pub azure_region: String,
	/// `fast` (Google/Azure) or `high` (LLM).
	#[serde(default = "default_quality")]
	pub quality: String,
	/// LLM provider: `deepseek` | `qwen` | `gemini`.
	#[serde(default = "default_llm_provider")]
	pub llm_provider: String,
	/// API key for the selected LLM provider.
	#[serde(default)]
	pub llm_api_key: String,
	/// Optional model override (provider default if empty).
	#[serde(default)]
	pub llm_model: String,
}

fn default_to() -> String {
	"km".into()
}

fn default_quality() -> String {
	"fast".into()
}

fn default_llm_provider() -> String {
	"deepseek".into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateTextsResult {
	pub translations: Vec<String>,
	pub provider: String,
	/// Optional user-facing note (e.g. LLM quota → Fast fallback).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub warning: Option<String>,
}

fn normalize_azure_from(from: &str) -> String {
	let f = from.trim().to_lowercase();
	if f.is_empty() || f == "zh" || f.starts_with("zh-cn") || f.starts_with("zh-hans") {
		return "zh-Hans".into();
	}
	if f.starts_with("zh-tw") || f.starts_with("zh-hant") {
		return "zh-Hant".into();
	}
	from.trim().to_string()
}

fn normalize_google_from(from: &str) -> String {
	let f = from.trim().to_lowercase();
	if f.is_empty() || f == "zh" || f.starts_with("zh-hans") || f.starts_with("zh-cn") {
		return "zh-CN".into();
	}
	if f.starts_with("zh-tw") || f.starts_with("zh-hant") {
		return "zh-TW".into();
	}
	from.trim().to_string()
}

fn normalize_to(to: &str) -> String {
	let t = to.trim().to_lowercase();
	if t.is_empty() {
		return "km".into();
	}
	if t.starts_with("km") {
		return "km".into();
	}
	t
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
	reqwest::blocking::Client::builder()
		.timeout(Duration::from_secs(45))
		.user_agent("ProfessorDubbedPro/0.1")
		.build()
		.map_err(|e| format!("Failed to create HTTP client: {e}"))
}

fn http_client_llm() -> Result<reqwest::blocking::Client, String> {
	reqwest::blocking::Client::builder()
		.timeout(Duration::from_secs(120))
		.user_agent("ProfessorDubbedPro/0.1")
		.build()
		.map_err(|e| format!("Failed to create HTTP client: {e}"))
}

const LLM_SYSTEM_PROMPT: &str = r#"You are a professional Chinese-to-Khmer subtitle translator for film, drama, livestream, and short-video dubbing (lip-sync).

You understand modern Mandarin: internet slang, relationship slang, sales/beauty-salon jargon, and rhetorical spoken style. Prefer the spoken sense used in short videos — not a naive dictionary gloss.

Rules:
- Translate each numbered Chinese line into natural, fluent spoken Khmer.
- Keep meaning accurate — especially slang, sarcasm, and business jargon.
- Preserve negation and rhetoric (怎么可能 / 难道 / 不是…吗 / 才…). Never flip yes/no meaning.
- Prefer concise spoken Khmer that fits lip-sync timing. Avoid padding or stiff literary Khmer.
- Be consistent: the same Chinese slang → the same Khmer wording in the batch.
- Do not add explanations, notes, romanization, Chinese, or English.
- Return ONLY a numbered list of Khmer translations matching the input numbers (1., 2., 3., …).

CRITICAL glossary (Chinese → preferred Khmer). Never invent other senses:
Relationship / people
- 小三 → ស្រីក្រៅ (mistress). NEVER ម្ចាស់ស្រី (female owner).
- 渣男 / 渣女 → ប្រុសអាក្រក់ / ស្រីអាក្រក់ (player who mistreats partners)
- 备胎 → ជម្រើសបម្រុង (backup romantic option)
- 舔狗 → អ្នកលើកតម្កើងពេក (overly clingy admirer)
- 绿茶 → ស្រីក្លែងស្លូត (fake-innocent woman)
- 海王 → ប្រុសលេងស្នេហ៍ច្រើននាក់
- 老板娘 → ភរិយាថៅកែ / ម្ចាស់ហាងស្រី (boss’s wife or female shop owner — only when 老板娘 is written)

Money / sales
- 保底 / 拿保底 / 搞保底 → ប្រាក់ធានា / បានប្រាក់ធានា (guaranteed pay). NOT product warranty.
- 持续保底 → ប្រាក់ធានាបន្ត
- 底薪 → ប្រាក់ខែគោល
- 提成 → កម្រៃលក់ / commission
- 业绩 → លទ្ធផលការលក់
- 升单 / 客单价 → ការឡើងបញ្ជាទិញ / តម្លៃក្នុងមួយអតិថិជន
- 成交 → លក់បាន / បិទការលក់
- 复购 → ទិញម្តងទៀត
- 起盘 → ចាប់ផ្តើមលក់ឡើងវិញ
- 老店新开 → បើកហាងចាស់ជាថ្មី
- 价值转换 → បំប្លែងតម្លៃទៅជាលទ្ធផល/ការលក់
- 店长 → អ្នកគ្រប់គ្រងហាង
- 老顾客 / 新顾客 → អតិថិជនចាស់ / អតិថិជនថ្មី

Ability / personality
- 高手 → អ្នកខ្លាំង / អ្នកជំនាញ (skilled top performer). NEVER ថ្នាក់អនុបណ្ឌិត (master’s degree) and NEVER “business boss” unless 老板 is written.
- 小气 → កំណាញ់ / ស្វិត (stingy). NEVER ឆេវឆាវ / hot-tempered.
- 无能 → គ្មានសមត្ថភាព
- 打工人 → កម្មករ/បុគ្គលិកធម្មតា
- 内卷 → ប្រកួតប្រជែងខ្លាំងពេកក្នុងវិស័យ
- 躺平 → ដេកស្ងៀមមិនប្រឹង
- 摆烂 → ទុកឲ្យអន់ទៅ
- 离谱 → ហួសសមហេតុ
- 破防 → ចាញ់អារម្មណ៍ / ត្រូវប៉ះពាល់អារម្មណ៍
- 下头 → ធ្វើឲ្យត្រជាក់ចិត្ត / បាត់ចំណាប់អារម្មណ៍
- 上头 → ជាប់អារម្មណ៍ខ្លាំង
- 割韭菜 → បោកប្រាស់អតិថិជន/ទស្សនិកជន
- 套路 → ល្បិច / យុទ្ធសាស្ត្របោក"#;

/// Glossary block appended to the user message so every provider sees it near the lines.
const LLM_GLOSSARY_REMINDER: &str = r#"Glossary reminder — apply strictly (modern Mandarin → spoken Khmer):
小三=ស្រីក្រៅ | 保底=ប្រាក់ធានា | 底薪=ប្រាក់ខែគោល | 升单=ការឡើងបញ្ជាទិញ | 高手=អ្នកខ្លាំង | 小气=កំណាញ់ | 店长=អ្នកគ្រប់គ្រងហាង | 成交=លក់បាន | 提成=កម្រៃលក់ | 起盘=ចាប់ផ្តើមលក់ឡើងវិញ | 老店新开=បើកហាងចាស់ជាថ្មី | 渣男=ប្រុសអាក្រក់ | 备胎=ជម្រើសបម្រុង | 打工人=បុគ្គលិកធម្មតា
Never: 小三→ម្ចាស់ស្រី | 高手→ថ្នាក់អនុបណ្ឌិត | 小气→ឆេវឆាវ. Keep negation (怎么可能) unflipped.
"#;

fn default_model_for(provider: &str) -> &'static str {
	match provider {
		"qwen" => "qwen-plus",
		// Gemini 3.x Flash — 2.x IDs are 404 for many new Google AI Studio keys.
		"gemini" => "gemini-3.5-flash",
		_ => "deepseek-chat",
	}
}

/// Static Gemini fallbacks when ListModels is unavailable (newest first).
fn gemini_static_defaults() -> &'static [&'static str] {
	&[
		"gemini-3.7-flash",
		"gemini-3.6-flash",
		"gemini-3.5-flash",
		"gemini-3.5-flash-lite",
		"gemini-3.1-flash-lite",
		"gemini-3-flash-preview",
		"gemini-flash-latest",
		"gemini-2.5-flash",
		"gemini-2.5-flash-lite",
	]
}

/// Ordered Gemini model candidates (preferred → API-discovered → static).
fn gemini_model_candidates(preferred: &str, discovered: &[String]) -> Vec<String> {
	let preferred = preferred.trim();
	let mut out: Vec<String> = Vec::new();
	let mut push = |m: &str| {
		let t = m.trim();
		if t.is_empty() {
			return;
		}
		if !out.iter().any(|x| x.eq_ignore_ascii_case(t)) {
			out.push(t.to_string());
		}
	};
	if !preferred.is_empty() {
		push(preferred);
	}
	// Prefer Flash / Lite for subtitle batches (cheaper + usually free-tier).
	let mut flash: Vec<&String> = discovered
		.iter()
		.filter(|m| {
			let l = m.to_ascii_lowercase();
			(l.contains("flash") || l.contains("lite")) && !l.contains("image") && !l.contains("tts")
		})
		.collect();
	flash.sort_by(|a, b| b.len().cmp(&a.len())); // stable-ish preference by specificity
	for m in flash {
		push(m);
	}
	for m in discovered {
		let l = m.to_ascii_lowercase();
		if l.contains("image") || l.contains("tts") || l.contains("embedding") {
			continue;
		}
		push(m);
	}
	for m in gemini_static_defaults() {
		push(m);
	}
	out
}

/// Ask Google which generateContent models this API key can use.
fn list_gemini_generate_models(
	client: &reqwest::blocking::Client,
	api_key: &str,
) -> Vec<String> {
	let url = format!(
		"https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&key={}",
		urlencoding_simple(api_key)
	);
	let Ok(resp) = client.get(&url).send() else {
		return Vec::new();
	};
	if !resp.status().is_success() {
		return Vec::new();
	}
	let Ok(text) = resp.text() else {
		return Vec::new();
	};
	let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
		return Vec::new();
	};
	let mut out = Vec::new();
	let Some(models) = parsed.get("models").and_then(|m| m.as_array()) else {
		return out;
	};
	for m in models {
		let methods = m
			.get("supportedGenerationMethods")
			.and_then(|v| v.as_array())
			.cloned()
			.unwrap_or_default();
		let supports = methods.iter().any(|x| {
			x.as_str()
				.map(|s| s.eq_ignore_ascii_case("generateContent"))
				.unwrap_or(false)
		});
		if !supports {
			continue;
		}
		let name = m
			.get("name")
			.and_then(|v| v.as_str())
			.unwrap_or("")
			.trim()
			.trim_start_matches("models/");
		if name.is_empty() {
			continue;
		}
		out.push(name.to_string());
	}
	out
}

fn is_model_unavailable(msg: &str) -> bool {
	let lower = msg.to_ascii_lowercase();
	lower.contains("404")
		|| lower.contains("not found")
		|| lower.contains("no longer available")
		|| lower.contains("is not found")
		|| lower.contains("not supported for generatecontent")
}

fn is_quota_exhausted(msg: &str) -> bool {
	let lower = msg.to_ascii_lowercase();
	lower.contains("quota")
		|| lower.contains("resource_exhausted")
		|| lower.contains("rate limit")
		|| lower.contains("too many requests")
		|| lower.contains("\"code\": 429")
		|| lower.contains("code\":429")
}

fn build_numbered_user_prompt(texts: &[String]) -> String {
	let mut out = String::from(LLM_GLOSSARY_REMINDER);
	out.push_str(
		"\nTranslate these Chinese subtitle lines into Khmer. Reply with the same numbers only:\n\n",
	);
	for (i, t) in texts.iter().enumerate() {
		out.push_str(&format!("{}. {}\n", i + 1, t.trim()));
	}
	out
}

/// Fix high-confidence Mandarin ASR mishears before translation (helps any video).
fn normalize_zh_source(text: &str) -> String {
	let mut out = text.to_string();
	let fixes: &[(&str, &str)] = &[
		// 总有一天废 + 男的也会玩腻了 (mistress discarded) — SenseVoice often hears 所有电费/总有电费
		("所有电费，男的也会", "总有一天废，男的也会"),
		("所有电费,男的也会", "总有一天废,男的也会"),
		("总有电费，男的也会", "总有一天废，男的也会"),
		("总有电费,男的也会", "总有一天废,男的也会"),
		("所有电费男的也会", "总有一天废男的也会"),
		("总有电费男的也会", "总有一天废男的也会"),
		// Common short-video ASR slips
		("转换身单", "转换升单"),
		("薪髓", "薪水"),
		("底下的你的薪", "底下人你的薪"),
	];
	for (from, to) in fixes {
		if out.contains(from) {
			out = out.replace(from, to);
		}
	}
	out
}

fn normalize_batch(texts: &[String]) -> Vec<String> {
	texts.iter().map(|t| normalize_zh_source(t)).collect()
}

/// Expand Chinese slang into clearer Mandarin before Azure/Google Fast MT.
/// Longest phrases first so compounds like 持续保底 win over 保底.
fn expand_zh_slang_for_mt(text: &str) -> String {
	let replacements: &[(&str, &str)] = &[
		("持续保底", "持续的保底工资"),
		("老店新开", "把老店当作新店重新开业"),
		("价值转换", "把价值转化成成交业绩"),
		("拿保底", "拿到保底工资"),
		("搞保底", "给保底工资"),
		("老顾客", "老客户"),
		("新顾客", "新客户"),
		("小三", "情妇"),
		("渣男", "玩弄感情的男人"),
		("渣女", "玩弄感情的女人"),
		("备胎", "备用恋爱对象"),
		("舔狗", "过分讨好对方的人"),
		("绿茶", "假装清纯的女人"),
		("海王", "同时和很多人谈恋爱的男人"),
		("保底", "保底工资"),
		("底薪", "基本工资"),
		("升单", "提高客单价"),
		("客单价", "每位顾客消费金额"),
		("提成", "销售提成"),
		("业绩", "销售业绩"),
		("高手", "业务高手"),
		("小气", "吝啬"),
		("店长", "门店经理"),
		("起盘", "重新开始做业绩"),
		("成交", "成功签单"),
		("复购", "再次购买"),
		("打工人", "普通上班族"),
		("内卷", "过度内卷竞争"),
		("躺平", "选择躺平不拼搏"),
		("摆烂", "故意摆烂不努力"),
		("离谱", "太离谱了"),
		("破防", "情绪破防了"),
		("下头", "让人下头扫兴"),
		("上头", "让人上头着迷"),
		("割韭菜", "收割韭菜式欺诈"),
		("套路", "骗人的套路"),
	];
	let mut out = text.to_string();
	for (from, to) in replacements {
		if out.contains(from) {
			out = out.replace(from, to);
		}
	}
	out
}

fn expand_batch_for_fast_mt(texts: &[String]) -> Vec<String> {
	texts.iter().map(|t| expand_zh_slang_for_mt(t)).collect()
}

/// Source-aware post-edit: force preferred Khmer when Chinese triggers are present.
/// Safe for any video — only rewrites known wrong Khmer senses.
fn enforce_zh_km_glossary(zh: &str, km: &str) -> String {
	if km.trim().is_empty() {
		return km.to_string();
	}
	let mut out = km.to_string();

	// (zh_trigger_any, bad_khmer_substrings → good)
	let rules: &[(&[&str], &[&str], &str)] = &[
		(
			&["小三"],
			&["ម្ចាស់ស្រី", "ម្ចាស់​ស្រី", "ម្ចាស់ ស្រី"],
			"ស្រីក្រៅ",
		),
		(
			&["高手"],
			&[
				"ថ្នាក់អនុបណ្ឌិត",
				"ចៅហ្វាយនាយអាជីវកម្ម",
				"ចៅហ្វាយនាយ",
				"អនុបណ្ឌិត",
			],
			"អ្នកខ្លាំង",
		),
		(
			&["小气"],
			&["ឆេវឆាវ", "ចិត្តអាក្រក់"],
			"កំណាញ់",
		),
		(
			&["保底", "拿保底", "搞保底", "持续保底"],
			&["ការធានាអប្បបរមាផលិតផល", "ការធានាទំនិញ"],
			"ប្រាក់ធានា",
		),
		(&["底薪"], &["ប្រាក់ឈ្នួលមូលដ្ឋានខុស"], "ប្រាក់ខែគោល"),
		(
			&["店长"],
			&["ប្រធានហាងខុស"],
			"អ្នកគ្រប់គ្រងហាង",
		),
		(&["渣男"], &[], "ប្រុសអាក្រក់"),
		(&["备胎"], &[], "ជម្រើសបម្រុង"),
	];

	for (triggers, bads, good) in rules {
		let hit = triggers.iter().any(|t| zh.contains(t));
		if !hit {
			continue;
		}
		for bad in *bads {
			if !bad.is_empty() && out.contains(bad) {
				out = out.replace(bad, good);
			}
		}
	}

	// Extra: 小气 on 老板 → prefer កំណាញ់ over leftover temper words near 老板/ថៅកែ
	if zh.contains("小气") && (zh.contains("老板") || out.contains("ថៅកែ") || out.contains("ចៅហ្វាយ"))
	{
		out = out.replace("មានចរិតឆេវឆាវ", "កំណាញ់");
		out = out.replace("ចរិតឆេវឆាវ", "កំណាញ់");
	}

	// 总有一天废 must not stay as electricity-bill Khmer (ASR→MT cascade).
	if zh.contains("总有一天废") || (zh.contains("玩腻") && zh.contains("丢掉")) {
		let bill_patterns = [
			"ការលេងជាមួយវិក័យប័ត្រអគ្គីសនីទាំងអស់ហើយនឹងបោះវាចេញពីអ្នក",
			"ការលេងជាមួយវិក័យប័ត្រអគ្គិសនីទាំងអស់ហើយនឹងបោះវាចេញពីអ្នក",
			"លេងជាមួយវិក័យប័ត្រអគ្គីសនីទាំងអស់",
			"លេងជាមួយវិក័យប័ត្រអគ្គិសនីទាំងអស់",
		];
		for p in bill_patterns {
			if out.contains(p) {
				out = out.replace(p, "លេងធុញទ្រាន់ហើយនឹងបោះបង់អ្នកចោល");
			}
		}
		out = out.replace("វិក័យប័ត្រអគ្គីសនី", "ការអស់តម្លៃ");
		out = out.replace("វិក័យប័ត្រអគ្គិសនី", "ការអស់តម្លៃ");
	}

	out
}

fn enforce_batch(sources: &[String], translations: Vec<String>) -> Vec<String> {
	translations
		.into_iter()
		.enumerate()
		.map(|(i, km)| {
			let zh = sources.get(i).map(|s| s.as_str()).unwrap_or("");
			enforce_zh_km_glossary(zh, &km)
		})
		.collect()
}

fn text_has_khmer(s: &str) -> bool {
	s.chars()
		.any(|c| matches!(c, '\u{1780}'..='\u{17FF}' | '\u{19E0}'..='\u{19FF}'))
}

fn text_has_han(s: &str) -> bool {
	s.chars().any(|c| matches!(c, '\u{4E00}'..='\u{9FFF}'))
}

/// True when a "Khmer" result is still Chinese (LLM echo) or identical to the source.
fn is_bad_km_translation(source: &str, translated: &str) -> bool {
	let t = translated.trim();
	if t.is_empty() {
		return true;
	}
	if text_has_khmer(t) {
		return false;
	}
	if text_has_han(t) {
		return true;
	}
	let s = source.trim();
	!s.is_empty() && t == s
}

fn finalize_translations(sources: &[String], translations: Vec<String>) -> Vec<String> {
	enforce_batch(sources, translations)
}

/// After MT/LLM, blank out Chinese-echo lines when target is Khmer (caller may Fast-retry).
fn scrub_non_khmer_when_target_km(to: &str, sources: &[String], translations: Vec<String>) -> Vec<String> {
	let to_l = to.trim().to_ascii_lowercase();
	if !(to_l == "km" || to_l.starts_with("km-") || to_l == "khm" || to_l == "khmer") {
		return translations;
	}
	translations
		.into_iter()
		.enumerate()
		.map(|(i, km)| {
			let zh = sources.get(i).map(|s| s.as_str()).unwrap_or("");
			if is_bad_km_translation(zh, &km) {
				String::new()
			} else {
				km
			}
		})
		.collect()
}

fn parse_numbered_translations(raw: &str, expected: usize) -> Result<Vec<String>, String> {
	let mut map: std::collections::BTreeMap<usize, String> = std::collections::BTreeMap::new();
	for line in raw.lines() {
		let line = line.trim();
		if line.is_empty() {
			continue;
		}
		// "1. text" / "1) text" / "1、text" / "1: text"
		let bytes = line.as_bytes();
		let mut i = 0usize;
		while i < bytes.len() && bytes[i].is_ascii_digit() {
			i += 1;
		}
		if i == 0 {
			continue;
		}
		let Ok(n) = line[..i].parse::<usize>() else {
			continue;
		};
		if n == 0 || n > expected {
			continue;
		}
		let rest = line[i..].trim_start();
		let rest = rest
			.trim_start_matches(['.', ')', ':', '、', '-', ' '])
			.trim();
		if rest.is_empty() {
			continue;
		}
		map.insert(n, rest.to_string());
	}

	if map.len() == expected {
		return Ok((1..=expected).map(|n| map.remove(&n).unwrap_or_default()).collect());
	}

	// Fallback: non-empty lines in order (when the model omits numbers).
	let plain: Vec<String> = raw
		.lines()
		.map(|l| l.trim().to_string())
		.filter(|l| !l.is_empty())
		.filter(|l| !l.to_ascii_lowercase().starts_with("here"))
		.take(expected)
		.collect();
	if plain.len() == expected {
		return Ok(plain);
	}

	if map.is_empty() {
		return Err(format!(
			"LLM returned an unparseable translation (expected {expected} lines)."
		));
	}

	// Partial map — fill gaps with empty (caller may retry / skip).
	Ok((1..=expected)
		.map(|n| map.remove(&n).unwrap_or_default())
		.collect())
}

fn is_hard_quota_error(msg: &str) -> bool {
	let lower = msg.to_ascii_lowercase();
	lower.contains("exceeded your current quota")
		|| lower.contains("check your plan and billing")
		|| lower.contains("quota exceeded")
		|| lower.contains("daily limit")
		|| lower.contains("billing details")
}

fn is_soft_rate_limit(msg: &str) -> bool {
	let lower = msg.to_ascii_lowercase();
	if is_hard_quota_error(msg) {
		return false;
	}
	lower.contains("429")
		|| lower.contains("rate limit")
		|| lower.contains("resource_exhausted")
		|| lower.contains("too many requests")
}

fn friendly_http_error(provider: &str, status: reqwest::StatusCode, body: &str) -> String {
	let lower = body.to_ascii_lowercase();
	if status.as_u16() == 404
		|| lower.contains("no longer available")
		|| lower.contains("is not found")
	{
		return format!(
			"{provider} model not available (404): {}",
			truncate(body, 180)
		);
	}
	if is_hard_quota_error(body)
		|| (status.as_u16() == 429 && lower.contains("quota"))
	{
		return format!(
			"{provider} free-tier quota is used up. Wait for the daily reset, enable billing in Google AI Studio, or use Fast mode for now."
		);
	}
	if status.as_u16() == 429
		|| lower.contains("rate limit")
		|| lower.contains("resource_exhausted")
	{
		return format!(
			"{provider} rate limit (429). Will retry briefly, then fall back to Fast if needed."
		);
	}
	if status.as_u16() == 401 || status.as_u16() == 403 {
		return format!("{provider} API key rejected ({status}). Check the key in Settings.");
	}
	format!(
		"{provider} request failed ({status}): {}",
		truncate(body, 220)
	)
}

fn with_retries<F>(label: &str, mut attempt: F) -> Result<Vec<String>, String>
where
	F: FnMut(u32) -> Result<Vec<String>, String>,
{
	// Soft rate limits only — hard daily quota will not recover from waiting.
	const MAX_TRIES: u32 = 3;
	let mut last_err = String::new();
	for try_n in 0..MAX_TRIES {
		match attempt(try_n) {
			Ok(v) => return Ok(v),
			Err(e) => {
				last_err = e;
				if is_hard_quota_error(&last_err) || is_model_unavailable(&last_err) {
					break;
				}
				let lower = last_err.to_ascii_lowercase();
				let retryable = is_soft_rate_limit(&last_err)
					|| lower.contains("timeout")
					|| lower.contains("temporar");
				if !retryable || try_n + 1 >= MAX_TRIES {
					break;
				}
				let wait_ms = 800u64 * (1u64 << try_n);
				log::warn!(
					"{label} attempt {} failed ({last_err}); retrying in {wait_ms}ms…",
					try_n + 1
				);
				thread::sleep(Duration::from_millis(wait_ms));
			}
		}
	}
	Err(last_err)
}

fn translate_openai_compatible(
	client: &reqwest::blocking::Client,
	endpoint: &str,
	api_key: &str,
	model: &str,
	texts: &[String],
) -> Result<Vec<String>, String> {
	with_retries("LLM", |_| {
		let body = serde_json::json!({
			"model": model,
			"temperature": 0.2,
			"messages": [
				{ "role": "system", "content": LLM_SYSTEM_PROMPT },
				{ "role": "user", "content": build_numbered_user_prompt(texts) }
			]
		});

		let resp = client
			.post(endpoint)
			.header("Authorization", format!("Bearer {api_key}"))
			.header("Content-Type", "application/json")
			.json(&body)
			.send()
			.map_err(|e| format!("LLM network error: {e}"))?;

		let status = resp.status();
		let text = resp
			.text()
			.map_err(|e| format!("LLM read error: {e}"))?;
		if !status.is_success() {
			return Err(friendly_http_error("LLM", status, &text));
		}

		let parsed: Value =
			serde_json::from_str(&text).map_err(|e| format!("LLM JSON error: {e}"))?;
		let content = parsed
			.pointer("/choices/0/message/content")
			.and_then(|v| v.as_str())
			.ok_or_else(|| "LLM response missing message content.".to_string())?;

		parse_numbered_translations(content, texts.len())
	})
}

fn translate_gemini(
	client: &reqwest::blocking::Client,
	api_key: &str,
	model: &str,
	texts: &[String],
) -> Result<Vec<String>, String> {
	with_retries("Gemini", |_| {
		let url = format!(
			"https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
			urlencoding_simple(model),
			urlencoding_simple(api_key)
		);
		let prompt = format!(
			"{}\n\n{}",
			LLM_SYSTEM_PROMPT,
			build_numbered_user_prompt(texts)
		);
		let body = serde_json::json!({
			"contents": [{
				"parts": [{ "text": prompt }]
			}],
			"generationConfig": {
				"temperature": 0.2
			}
		});

		let resp = client
			.post(&url)
			.header("Content-Type", "application/json")
			.json(&body)
			.send()
			.map_err(|e| format!("Gemini network error: {e}"))?;

		let status = resp.status();
		let text = resp
			.text()
			.map_err(|e| format!("Gemini read error: {e}"))?;
		if !status.is_success() {
			return Err(friendly_http_error("Gemini", status, &text));
		}

		let parsed: Value =
			serde_json::from_str(&text).map_err(|e| format!("Gemini JSON error: {e}"))?;
		let content = parsed
			.pointer("/candidates/0/content/parts/0/text")
			.and_then(|v| v.as_str())
			.ok_or_else(|| "Gemini response missing text.".to_string())?;

		parse_numbered_translations(content, texts.len())
	})
}

fn translate_gemini_resolved(
	client: &reqwest::blocking::Client,
	api_key: &str,
	preferred_model: &str,
	texts: &[String],
	discovered: &[String],
) -> Result<(Vec<String>, String), String> {
	let candidates = gemini_model_candidates(preferred_model, discovered);
	let mut last_err = String::new();
	for model in &candidates {
		match translate_gemini(client, api_key, model, texts) {
			Ok(out) => {
				if model != preferred_model && !preferred_model.is_empty() {
					log::info!("Gemini model `{preferred_model}` unavailable; using `{model}`");
				}
				return Ok((out, model.clone()));
			}
			Err(err) => {
				last_err = err;
				if is_model_unavailable(&last_err) {
					log::warn!("Gemini model `{model}` unavailable; trying next… ({last_err})");
					continue;
				}
				// Free-tier quota applies across models — fail fast to Fast MT.
				if is_quota_exhausted(&last_err) {
					return Err(last_err);
				}
				return Err(last_err);
			}
		}
	}
	Err(if last_err.is_empty() {
		"No Gemini generateContent models available for this API key. Use Fast mode, DeepSeek, or Qwen.".into()
	} else {
		last_err
	})
}

fn translate_llm(
	texts: &[String],
	provider: &str,
	api_key: &str,
	model_override: &str,
) -> Result<(Vec<String>, String), String> {
	let key = api_key.trim();
	if key.is_empty() {
		return Err(
			"High Quality translation needs an LLM API key. Add one in Settings (DeepSeek / Qwen / Gemini)."
				.into(),
		);
	}
	if texts.is_empty() {
		return Ok((vec![], "none".into()));
	}

	let provider = provider.trim().to_ascii_lowercase();
	let model = if model_override.trim().is_empty() {
		default_model_for(&provider).to_string()
	} else {
		model_override.trim().to_string()
	};
	let client = http_client_llm()?;

	// Prefer larger Gemini batches so free-tier daily request caps go further.
	let (batch, gap_ms) = match provider.as_str() {
		"gemini" => (12usize, 900u64),
		"qwen" => (8usize, 200u64),
		_ => (10usize, 120u64),
	};

	let mut out = Vec::with_capacity(texts.len());
	let mut used_gemini_model = model.clone();
	let gemini_discovered = if provider == "gemini" {
		let discovered = list_gemini_generate_models(&client, key);
		if !discovered.is_empty() {
			log::info!(
				"Gemini ListModels returned {} generateContent model(s) for this key",
				discovered.len()
			);
		}
		discovered
	} else {
		Vec::new()
	};
	let chunks: Vec<&[String]> = texts.chunks(batch).collect();
	for (idx, chunk) in chunks.iter().enumerate() {
		if idx > 0 {
			thread::sleep(Duration::from_millis(gap_ms));
		}
		let part = match provider.as_str() {
			"qwen" => translate_openai_compatible(
				&client,
				"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
				key,
				&model,
				chunk,
			)?,
			"gemini" => {
				let (part, resolved) = translate_gemini_resolved(
					&client,
					key,
					&used_gemini_model,
					chunk,
					&gemini_discovered,
				)?;
				used_gemini_model = resolved;
				part
			}
			_ => translate_openai_compatible(
				&client,
				"https://api.deepseek.com/chat/completions",
				key,
				&model,
				chunk,
			)?,
		};
		if part.len() != chunk.len() {
			return Err(format!(
				"LLM returned {} lines for a batch of {}.",
				part.len(),
				chunk.len()
			));
		}
		out.extend(part);
	}

	let label = match provider.as_str() {
		"qwen" => "qwen",
		"gemini" => "gemini",
		_ => "deepseek",
	};
	Ok((out, label.into()))
}

fn translate_azure(
	client: &reqwest::blocking::Client,
	texts: &[String],
	from: &str,
	to: &str,
	key: &str,
	region: &str,
) -> Result<Vec<String>, String> {
	let from = normalize_azure_from(from);
	let to = normalize_to(to);
	let mut out = Vec::with_capacity(texts.len());

	for chunk in texts.chunks(AZURE_BATCH) {
		let body: Vec<Value> = chunk
			.iter()
			.map(|t| serde_json::json!({ "Text": t }))
			.collect();

		let url = format!(
			"https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from={}&to={}",
			urlencoding_simple(&from),
			urlencoding_simple(&to)
		);

		let mut req = client
			.post(&url)
			.header("Ocp-Apim-Subscription-Key", key)
			.header("Content-Type", "application/json; charset=UTF-8")
			.json(&body);

		let region_trim = region.trim();
		if !region_trim.is_empty() && !region_trim.eq_ignore_ascii_case("global") {
			req = req.header("Ocp-Apim-Subscription-Region", region_trim);
		}

		let resp = req
			.send()
			.map_err(|e| format!("Azure Translator network error: {e}"))?;

		let status = resp.status();
		let text = resp
			.text()
			.map_err(|e| format!("Azure Translator read error: {e}"))?;

		if !status.is_success() {
			let hint = if status.as_u16() == 401 || status.as_u16() == 403 {
				" Check your Azure Translator key and region in Settings."
			} else {
				""
			};
			return Err(format!(
				"Azure Translator failed ({status}): {}{hint}",
				truncate(&text, 240)
			));
		}

		let parsed: Value = serde_json::from_str(&text)
			.map_err(|e| format!("Azure Translator JSON error: {e}"))?;

		let arr = parsed
			.as_array()
			.ok_or_else(|| "Azure Translator returned unexpected JSON.".to_string())?;

		if arr.len() != chunk.len() {
			return Err(format!(
				"Azure Translator returned {} results for {} texts.",
				arr.len(),
				chunk.len()
			));
		}

		for item in arr {
			let translated = item
				.get("translations")
				.and_then(|t| t.as_array())
				.and_then(|a| a.first())
				.and_then(|t| t.get("text"))
				.and_then(|t| t.as_str())
				.unwrap_or("")
				.to_string();
			out.push(translated);
		}
	}

	Ok(out)
}

fn translate_google_one(
	client: &reqwest::blocking::Client,
	text: &str,
	from: &str,
	to: &str,
) -> Result<String, String> {
	if text.trim().is_empty() {
		return Ok(String::new());
	}

	let from = normalize_google_from(from);
	let to = normalize_to(to);
	let url = format!(
		"https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl={}&dt=t&q={}",
		urlencoding_simple(&from),
		urlencoding_simple(&to),
		urlencoding_simple(text)
	);

	let resp = client
		.get(&url)
		.send()
		.map_err(|e| format!("Google Translate network error: {e}"))?;

	let status = resp.status();
	let body = resp
		.text()
		.map_err(|e| format!("Google Translate read error: {e}"))?;

	if !status.is_success() {
		return Err(format!(
			"Google Translate failed ({status}): {}",
			truncate(&body, 240)
		));
	}

	parse_google_translation(&body)
}

fn parse_google_translation(body: &str) -> Result<String, String> {
	let parsed: Value = serde_json::from_str(body)
		.map_err(|e| format!("Google Translate JSON error: {e}"))?;

	// Shape: [ [ [translated, original, ...], ... ], ... ]
	let segments = parsed
		.as_array()
		.and_then(|a| a.first())
		.and_then(|v| v.as_array())
		.ok_or_else(|| "Google Translate returned unexpected JSON.".to_string())?;

	let mut out = String::new();
	for seg in segments {
		if let Some(arr) = seg.as_array() {
			if let Some(t) = arr.first().and_then(|v| v.as_str()) {
				out.push_str(t);
			}
		}
	}

	if out.is_empty() && !body.trim().is_empty() {
		return Err("Google Translate returned an empty translation.".into());
	}
	Ok(out)
}

fn translate_google(
	client: &reqwest::blocking::Client,
	texts: &[String],
	from: &str,
	to: &str,
) -> Result<Vec<String>, String> {
	let mut out = Vec::with_capacity(texts.len());
	for (i, text) in texts.iter().enumerate() {
		if i > 0 {
			thread::sleep(Duration::from_millis(GOOGLE_DELAY_MS));
		}
		out.push(translate_google_one(client, text, from, to)?);
	}
	Ok(out)
}

fn finalize_for_target(
	to: &str,
	sources: &[String],
	translations: Vec<String>,
) -> Vec<String> {
	scrub_non_khmer_when_target_km(to, sources, finalize_translations(sources, translations))
}

/// Re-translate blanked (Chinese-echo) rows with Fast MT when target is Khmer.
fn fill_bad_km_with_fast(
	client: &reqwest::blocking::Client,
	args: &TranslateTextsArgs,
	sources: &[String],
	mut translations: Vec<String>,
) -> Result<(Vec<String>, usize), String> {
	let bad: Vec<usize> = translations
		.iter()
		.enumerate()
		.filter(|(_, t)| t.trim().is_empty())
		.map(|(i, _)| i)
		.collect();
	if bad.is_empty() {
		return Ok((translations, 0));
	}

	let subset: Vec<String> = bad.iter().map(|&i| sources[i].clone()).collect();
	let fast_texts = expand_batch_for_fast_mt(&subset);
	let key = args.azure_key.trim();
	let filled = if !key.is_empty() {
		match translate_azure(
			client,
			&fast_texts,
			&args.from,
			&args.to,
			key,
			&args.azure_region,
		) {
			Ok(t) => t,
			Err(_) => translate_google(client, &fast_texts, &args.from, &args.to)?,
		}
	} else {
		translate_google(client, &fast_texts, &args.from, &args.to)?
	};
	let filled = finalize_for_target(&args.to, &subset, filled);

	for (k, &i) in bad.iter().enumerate() {
		if let Some(t) = filled.get(k) {
			if !t.trim().is_empty() {
				translations[i] = t.clone();
			}
		}
	}
	Ok((translations, bad.len()))
}

fn translate_blocking(args: TranslateTextsArgs) -> Result<TranslateTextsResult, String> {
	if args.texts.is_empty() {
		return Ok(TranslateTextsResult {
			translations: vec![],
			provider: "none".into(),
			warning: None,
		});
	}

	// Normalize ASR slips, then keep this batch as the glossary enforcement source.
	let sources = normalize_batch(&args.texts);
	let quality = args.quality.trim().to_ascii_lowercase();
	if quality == "high" || quality == "llm" {
		match translate_llm(
			&sources,
			&args.llm_provider,
			&args.llm_api_key,
			&args.llm_model,
		) {
			Ok((translations, provider)) => {
				let translations = finalize_for_target(&args.to, &sources, translations);
				let client = http_client()?;
				let (translations, repaired) =
					fill_bad_km_with_fast(&client, &args, &sources, translations)?;
				let warning = if repaired > 0 {
					Some(format!(
						"{repaired} line(s) came back as Chinese from High Quality — retranslated with Fast."
					))
				} else {
					None
				};
				return Ok(TranslateTextsResult {
					translations,
					provider: if repaired > 0 {
						format!("{provider}+fast")
					} else {
						provider
					},
					warning,
				});
			}
			Err(llm_err) => {
				// Fall back to Fast mode so the user still gets a result.
				log::warn!("High-quality LLM translation failed, falling back to Fast: {llm_err}");
				let warning = Some(format!(
					"High Quality failed — used Fast instead. {llm_err}"
				));
				let client = http_client()?;
				let fast_texts = expand_batch_for_fast_mt(&sources);
				let key = args.azure_key.trim();
				if !key.is_empty() {
					if let Ok(translations) = translate_azure(
						&client,
						&fast_texts,
						&args.from,
						&args.to,
						key,
						&args.azure_region,
					) {
						return Ok(TranslateTextsResult {
							translations: finalize_for_target(&args.to, &sources, translations),
							provider: "azure".into(),
							warning,
						});
					}
				}
				let translations = translate_google(&client, &fast_texts, &args.from, &args.to)
					.map_err(|fast_err| {
						format!("{llm_err} — Fast fallback also failed: {fast_err}")
					})?;
				return Ok(TranslateTextsResult {
					translations: finalize_for_target(&args.to, &sources, translations),
					provider: "google".into(),
					warning,
				});
			}
		}
	}

	let client = http_client()?;
	let key = args.azure_key.trim();
	let fast_texts = expand_batch_for_fast_mt(&sources);

	if !key.is_empty() {
		match translate_azure(
			&client,
			&fast_texts,
			&args.from,
			&args.to,
			key,
			&args.azure_region,
		) {
			Ok(translations) => {
				return Ok(TranslateTextsResult {
					translations: finalize_for_target(&args.to, &sources, translations),
					provider: "azure".into(),
					warning: None,
				});
			}
			Err(azure_err) => {
				log::warn!("Azure Translator failed, falling back to Google: {azure_err}");
				let translations = translate_google(&client, &fast_texts, &args.from, &args.to)
					.map_err(|google_err| {
						format!("{azure_err} — Google fallback also failed: {google_err}")
					})?;
				return Ok(TranslateTextsResult {
					translations: finalize_for_target(&args.to, &sources, translations),
					provider: "google".into(),
					warning: Some(format!("Azure failed — used Google. {azure_err}")),
				});
			}
		}
	}

	let translations = translate_google(&client, &fast_texts, &args.from, &args.to)?;
	Ok(TranslateTextsResult {
		translations: finalize_for_target(&args.to, &sources, translations),
		provider: "google".into(),
		warning: None,
	})
}

/// Minimal URL encoding for query values (UTF-8 percent-encode).
fn urlencoding_simple(s: &str) -> String {
	let mut out = String::with_capacity(s.len() * 3);
	for b in s.as_bytes() {
		match *b {
			b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
				out.push(*b as char)
			}
			b' ' => out.push_str("%20"),
			_ => out.push_str(&format!("%{b:02X}")),
		}
	}
	out
}

fn truncate(s: &str, max: usize) -> String {
	let t = s.trim().replace('\n', " ");
	if t.chars().count() <= max {
		return t;
	}
	format!("{}…", t.chars().take(max).collect::<String>())
}

#[tauri::command]
pub async fn translate_texts(args: TranslateTextsArgs) -> Result<TranslateTextsResult, String> {
	tauri::async_runtime::spawn_blocking(move || translate_blocking(args))
		.await
		.map_err(|e| format!("Translation task failed: {e}"))?
}

#[cfg(test)]
mod tests {
	use super::{
		enforce_zh_km_glossary, expand_zh_slang_for_mt, normalize_zh_source,
	};

	#[test]
	fn expands_mistress_and_guarantee_slang() {
		let s = expand_zh_slang_for_mt("只有小三才会拿保底，高手不小气");
		assert!(s.contains("情妇"), "{s}");
		assert!(s.contains("保底工资"), "{s}");
		assert!(s.contains("业务高手"), "{s}");
		assert!(s.contains("吝啬"), "{s}");
		assert!(!s.contains("小三"), "{s}");
	}

	#[test]
	fn expands_compound_before_simple() {
		let s = expand_zh_slang_for_mt("能不能拿持续保底的");
		assert!(s.contains("持续的保底工资"), "{s}");
	}

	#[test]
	fn enforces_mistress_not_female_owner() {
		let km = enforce_zh_km_glossary(
			"问题是小三能不能拿持续保底的？",
			"សំណួរសួរថា តើម្ចាស់ស្រីអាចទទួលបានប្រាក់ធានាទេ?",
		);
		assert!(km.contains("ស្រីក្រៅ"), "{km}");
		assert!(!km.contains("ម្ចាស់ស្រី"), "{km}");
	}

	#[test]
	fn enforces_stingy_not_hot_temper() {
		let km = enforce_zh_km_glossary(
			"到底是老板小气还是店长无能，老板才小气",
			"តើថៅកែមានចរិតឆេវឆាវ ឬអ្នកគ្រប់គ្រងហាងគ្មានសមត្ថភាព?",
		);
		assert!(km.contains("កំណាញ់"), "{km}");
		assert!(!km.contains("ឆេវឆាវ"), "{km}");
	}

	#[test]
	fn enforces_expert_not_masters_degree() {
		let km = enforce_zh_km_glossary(
			"高手靠的是价值转换",
			"ថ្នាក់អនុបណ្ឌិតពឹងផ្អែកលើការបំប្លែងតម្លៃ",
		);
		assert!(km.contains("អ្នកខ្លាំង"), "{km}");
		assert!(!km.contains("អនុបណ្ឌិត"), "{km}");
	}

	#[test]
	fn normalizes_electricity_bill_asr_slip() {
		let s = normalize_zh_source("所有电费，男的也会玩腻了，也会把你丢掉");
		assert!(s.contains("总有一天废"), "{s}");
		assert!(!s.contains("所有电费"), "{s}");
	}

	#[test]
	fn enforces_bill_cascade_after_normalize() {
		let zh = normalize_zh_source("所有电费，男的也会玩腻了，也会把你丢掉");
		let km = enforce_zh_km_glossary(
			&zh,
			"បុរសក៏នឹងធុញទ្រាន់នឹងការលេងជាមួយវិក័យប័ត្រអគ្គីសនីទាំងអស់ហើយនឹងបោះវាចេញពីអ្នក។",
		);
		assert!(!km.contains("វិក័យប័ត្រ"), "{km}");
		assert!(km.contains("បោះបង់") || km.contains("ធុញ"), "{km}");
	}
}
