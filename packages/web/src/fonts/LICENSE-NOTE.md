# Font licensing — read before shipping publicly

`SF-Pro.woff2`, `SF-Mono-Regular.woff2` and `SF-Mono-Medium.woff2` are derived from
Apple's SF Pro and SF Mono, downloaded from
<https://developer.apple.com/fonts/>, subset and converted to WOFF2.

**These were vendored at the repository owner's explicit direction.**

## The constraint

Apple's licence for the SF fonts permits use *"solely for the purpose of creating
mock-ups of user interfaces to be used in software products running on Apple's iOS,
iPadOS, macOS, tvOS or watchOS"*, and does not grant redistribution rights. Serving
them from a web application — to any browser, on any platform — is outside that grant.

Read the licence bundled with the download for the authoritative terms; the summary
above is not legal advice.

## What this means in practice

- **Local development and internal demos**: low risk, and the intended look.
- **A publicly deployed web app**: outside the licence as written. Redistribution to
  every visitor's browser is exactly what the grant excludes.

## The compliant alternative, if that becomes a problem

Remove the three `.woff2` files and this directory's import, then restore the previous
stack:

```css
--sans: -apple-system, BlinkMacSystemFont, 'Inter Variable', Inter, system-ui, sans-serif;
```

`-apple-system` renders genuine SF Pro on Apple devices straight from the OS — fully
licensed, because nothing is being redistributed — and [Inter](https://rsms.me/inter/)
(SIL OFL) covers every other platform. `@fontsource-variable/inter` is still in
`package.json` for exactly this reason, so the swap is a two-line change.

The visual difference between that stack and this one is only visible to non-Apple
users, and Inter was designed to be close.
