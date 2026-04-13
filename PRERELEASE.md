# Pre-Release Checklist

Run through this before every version bump and deploy.

## Code Quality
- [ ] No `console.log` left in production code (except background.js startup message)
- [ ] No hardcoded test data or placeholder text
- [ ] All TODO/FIXME comments resolved or tracked

## Manifest
- [ ] `version` bumped in `manifest.json`
- [ ] Permissions are minimal — no unnecessary permissions added
- [ ] `host_permissions` only includes required domains

## Functionality
- [ ] Extension loads without errors in `chrome://extensions`
- [ ] Star trigger button appears on LinkedIn feed
- [ ] Panel opens/closes correctly
- [ ] Editor: typing, formatting (bold/italic/bullets), emoji picker work
- [ ] Smart format: detects lists, bolds key phrases, normalizes spacing
- [ ] Hooks and CTAs: browsing, filtering, inserting into editor
- [ ] Drafts: save, load, autosave
- [ ] Snippets: create, insert, delete
- [ ] Preview: desktop/mobile toggle, text updates live
- [ ] Profile: name, headline, avatar load from LinkedIn page

## Publish Flow
- [ ] Publish button opens preview overlay
- [ ] Preview shows correct formatted post with profile info
- [ ] Confirm opens LinkedIn composer (shadow DOM access works)
- [ ] Text inserts into Quill editor
- [ ] LinkedIn "Post" button is clicked automatically
- [ ] Navigates to published post after completion
- [ ] Fallback: copies to clipboard if composer fails

## Settings
- [ ] Anthropic API key save/load works
- [ ] Export drafts produces valid JSON

## Edge Cases
- [ ] Works on `/feed/`, `/in/`, `/feed/update/` pages
- [ ] Panel doesn't break LinkedIn layout
- [ ] Multiple open/close cycles don't duplicate elements
- [ ] Long posts (>2000 chars) render correctly in preview

## Before Push
- [ ] `git diff` reviewed — no secrets, no debug code
- [ ] Version in `manifest.json` matches release tag
- [ ] CHANGELOG updated (if exists)
