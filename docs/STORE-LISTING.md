# Chrome Web Store — Submission Assets

All copy is ready to paste into the Developer Dashboard listing. Character limits noted.
Primary listing language: **English**. A Hebrew variant is provided for the second locale.

---

## 1. Item name (max 75 chars)

```
מחיקון · Mechikon — PII Anonymizer for AI Chats
```

> Matches the manifest `name`. "Hebrew" was dropped from the descriptor since the tool now
> masks both Hebrew and English PII; the מחיקון brand prefix is kept.

## 2. Summary / short description (max 132 chars)

```
Mask personal details in Hebrew & English before sending them to ChatGPT, Claude or Gemini — 100% in your browser.
```

## 3. Detailed description

```
Mechikon masks sensitive personal information before it ever reaches an AI chat.

Type or paste into ChatGPT, Claude, or Gemini as usual. Mechikon detects names,
ID numbers, phone numbers, emails, credit-card and other sensitive values, and
replaces them with neutral tokens like [NAME_1] before the message is sent. The
AI sees only the masked text. When the answer comes back, tokens are turned back
into the real values automatically — locally, in your browser.

WHY MECHIKON
- Your sensitive data never leaves your device. Masking and restoring happen
  entirely on-device.
- The AI only ever receives masked tokens, never the real values.
- Works in both Hebrew and English — it detects the language of your text and
  masks accordingly.
- Also handles files: drop a PDF, Word, or text file into the popup to get a
  masked, AI-ready version.

WHAT IT DETECTS
- Names, organizations, and places (Hebrew and English)
- Israeli ID (Teudat Zehut), company numbers, IBAN, phone numbers
- Email addresses, credit-card numbers, US SSN and US phone numbers
- Anything you select by hand — click a word to mask it yourself.

PRIVACY BY DESIGN
- No accounts, no tracking, no analytics, no ads, no servers.
- The only network request is a one-time download of the name-detection model
  from the Hugging Face CDN — model weights only, never your text.
- The restore key is stored locally and expires after 24 hours.
- Open source (AGPL-3.0) — you can inspect exactly what the code does.

Made in Israel for anyone who wants to use AI chats without handing over
personal data.
```

## 4. Category

```
Productivity
```

## 5. Language(s)

```
English (primary), Hebrew
```

## 6. Single-purpose description (required by Store review)

```
Mechikon has one purpose: to mask personal and sensitive information in text
before the user sends it to an AI chat, and to restore it locally afterward. All
processing happens on-device; no user data is collected or transmitted.
```

## 7. Permission justifications (paste into each field)

- **storage**
  ```
  Stores the local restore key (token -> original value) so the user can un-mask
  the AI's reply. The key never leaves the device and expires after 24 hours.
  ```
- **offscreen**
  ```
  Runs the on-device name-detection model (WASM) in an offscreen document, which
  a service worker cannot host. No data is sent anywhere.
  ```
- **host permission: `https://huggingface.co/*`, `https://*.hf.co/*`, `https://*.huggingface.co/*`**
  ```
  Solely to download the name-detection model weights (one-time, cached). No user
  text or personal data is included in the request.
  ```
- **content scripts on chatgpt.com, chat.openai.com, claude.ai, gemini.google.com**
  ```
  To show the masking controls inside those chat composers and mask the text the
  user chooses before it is sent. The extension does not read or transmit page
  content anywhere.
  ```

## 8. Data-usage disclosures (Privacy practices tab)

- Does the extension collect or use user data? **No.**
- Certify all three:
  - [x] I do not sell or transfer user data to third parties (outside approved use cases).
  - [x] I do not use or transfer user data for purposes unrelated to the item's single purpose.
  - [x] I do not use or transfer user data to determine creditworthiness or for lending.

## 9. Privacy policy URL (required)

Hosted on the web app (PR #148 → merge + deploy makes it live):

```
https://mechikon.bai-solutions.com/extension-privacy.html
```

---

## Submission checklist

- [ ] Decide manifest name (keep "Hebrew" or drop it) — section 1
- [ ] `npm run build` (clean, no MECHIKON_E2E) then `npm run pack` -> zip
- [ ] Host PRIVACY.md at a public URL — section 9
- [ ] 1-5 screenshots, 1280x800 or 640x400 (see below)
- [ ] Icon 128x128 — already in `public/icons/icon-128.png`
- [ ] Pay the one-time $5 developer registration fee (if not already registered)
- [ ] Upload the zip, paste all copy above, submit for review

### Screenshots to capture (while testing)
1. The floating chip on a real ChatGPT/Claude/Gemini composer with Hebrew text masked.
2. Same with English text (chip in English, tokens like [NAME_1]).
3. The send-guard toast blocking an unmasked ID/SSN.
4. The popup with a file dropped -> masked, AI-ready output.
5. A restored AI answer (tokens turned back into real values).
