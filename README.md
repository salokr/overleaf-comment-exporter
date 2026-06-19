<div align="center">

# 📝 Overleaf Comment Exporter

### Export **every** review comment from an Overleaf project to Markdown, CSV & JSON — in one click.

**Overleaf won't let you export your comments. So I built the thing that does.**

[![Chrome Web Store](https://img.shields.io/badge/Chrome-Add%20to%20Chrome-blue?logo=googlechrome&logoColor=white)](#-install)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success)](manifest.json)
[![100%25 Local](https://img.shields.io/badge/Privacy-100%25%20local-brightgreen)](PRIVACY.md)
[![No tracking](https://img.shields.io/badge/Tracking-none-brightgreen)](PRIVACY.md)
[![License](https://img.shields.io/badge/License-MIT-lightgrey)](#-license)
[![Stars](https://img.shields.io/github/stars/salokr/overleaf-comment-exporter?style=social)](https://github.com/salokr/overleaf-comment-exporter)

<br/>

<!-- 📸 ToDo: drop a 15-second screen recording here. This single GIF converts more than the whole README. -->
<!-- Record it, save as docs/demo.gif, then this line shows it: -->
<!-- ![Demo](docs/demo.gif) -->

**[ Install ](#-install) · [ How it works ](#-how-it-works) · [ Why ](#-the-problem) · [ Roadmap ](#-roadmap)**

</div>

---

## 😩 The problem

When you download an Overleaf project — or pull it via Git — **your comments and track-changes don't come with it.** They're silently stripped. Years of [feature requests](https://github.com/overleaf/overleaf/issues/1126) ([#747](https://github.com/overleaf/web/issues/747), [toolkit #428](https://github.com/overleaf/toolkit/issues/428)) have gone unanswered.

So when a paper leaves Overleaf, all that reviewer feedback — the stuff you need for your **response-to-reviewers letter** and your revision history — just... vanishes.

**This extension gets it back.** One click, full record, grouped by file, in the formats you actually use.

---

## ✨ What it does

- 🗂️ **Scans every file** in your project automatically — or just the one you have open.
- 💬 **Captures the whole thread** — every message, reply, author, and timestamp, including **resolved** comments.
- ✂️ **Maps each comment to the highlighted text** it's attached to, plus surrounding context.
- 📊 **Groups by file** with a per-file comment count summary.
- 📥 **Exports to Markdown, CSV, and JSON** — pick any or all.
- 🔒 **Runs 100% in your browser.** No servers, no accounts, no uploads, no tracking. [See the privacy note.](PRIVACY.md)

---

## 🚀 Install

### Option A — Chrome Web Store *(recommended, one click)*
> 🛠️ **Coming soon** — listing under review. Star the repo to get notified when it lands.

### Option B — Load it unpacked *(works right now, 60 seconds)*
1. **[Download the latest release](https://github.com/salokr/overleaf-comment-exporter/releases)** (or `git clone` this repo).
2. Go to `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** → select this folder.
5. Pin the 💬 icon to your toolbar.

Works on Chrome, Edge, Brave, and any Chromium browser.

---

## 🎯 How to use

1. Open your **Overleaf project**.
2. Click the extension icon.
3. Pick your **scope** (all files / current file) and **formats** (MD / CSV / JSON).
4. Hit **Scan & export**.

It opens the Review panel for you and clicks through each file automatically. **Keep the tab in front while it runs** — then your files download. That's it.

---

## 📦 What you get

**Markdown** — clean, readable, grouped by file with the commented snippet, context, and full thread:

```markdown
## introduction.tex  (3)

### 1.
**Commented text**
    We achieve state-of-the-art results on all benchmarks.
**Comments**
- **Dr. Reviewer · Jun 12, 2026:** "all"? Be careful — Table 3 shows we're second on GLUE.
```

**CSV** — one row per message, ready for Excel / Sheets / pandas.
**JSON** — structured, every field, ready to script against.

---

## 🥇 How it compares

| | **This extension** | Console-script tools | Snapshot parsers |
|---|:---:|:---:|:---:|
| One-click, no DevTools | ✅ | ❌ (paste into console) | ❌ (save HTML first) |
| Scans **all files** automatically | ✅ | ❌ current file only | ⚠️ manual |
| Full thread + replies + authors | ✅ | ⚠️ | ⚠️ |
| Includes **resolved** comments | ✅ | ❌ | ⚠️ |
| MD **+** CSV **+** JSON | ✅ | ❌ MD only | ⚠️ |
| Per-file counts & summary | ✅ | ❌ | ❌ |
| Runs 100% locally | ✅ | ✅ | ✅ |

---

## 🔒 Privacy

Everything happens locally in your browser, using your existing logged-in Overleaf session — the same way the Overleaf page itself reads your comments. **Nothing is ever uploaded.** No analytics, no tracking, no third-party calls. Files download straight to your device. → [Full privacy note](PRIVACY.md)

---

## 🏠 Self-hosted Overleaf (Server Pro / Community)

By default it runs on `overleaf.com`. To use it on your own instance, add your domain to `manifest.json` under `host_permissions`:

```json
"host_permissions": [
  "https://www.overleaf.com/*",
  "https://*.overleaf.com/*",
  "https://overleaf.my-university.edu/*"
]
```

…then reload the extension.

---

## 🗺️ Roadmap

Vote with a 👍 on the issues — it directly shapes what I build next.

- [ ] 📄 **Annotated PDF** — render comments back into the compiled PDF (the [most-requested Overleaf feature](https://github.com/overleaf/overleaf/issues/1126))
- [ ] 📬 **Response-to-Reviewers generator** — auto-draft a revision letter, one quoted comment + response slot at a time
- [ ] ✅ **Action-item export** — turn open comments into a Markdown checklist / GitHub issues
- [ ] 📊 **Reviewer analytics** — comments per file/section/author, resolved vs. open
- [ ] 🤖 **AI triage** *(opt-in, bring-your-own-key)* — cluster, summarize, and draft responses
- [ ] 📝 **.docx export** with native Word comments

---

## 🤝 Contributing

It relies on Overleaf's internal endpoints and current UI, so an Overleaf redesign may occasionally need a small fix. PRs and bug reports are very welcome — [open an issue](https://github.com/salokr/overleaf-comment-exporter/issues).

**If this saved you an afternoon of copy-pasting, please ⭐ the repo** — it's the only way other researchers find it.

---

## 📄 License

MIT — do whatever you like with it. No warranty.

<div align="center">
<br/>
Made for everyone who's ever lost their reviewer comments to a project download.
</div>
