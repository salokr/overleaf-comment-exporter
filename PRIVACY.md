# Privacy

Overleaf Comment Exporter runs entirely in your browser.

- It only acts on the Overleaf project tab you have open, and only when you click
  the button.
- It reads the project's comments using your existing logged-in Overleaf session
  (the same way the Overleaf page itself does) and saves them as files on your
  computer.
- It does **not** send your data, comments, cookies, or credentials to any server
  operated by the extension or any third party. There is no analytics, no
  tracking, and no external network calls beyond Overleaf itself.
- The downloaded files stay on your device.

Permissions used:
- `activeTab` / `scripting`: to run the export on the Overleaf tab when you click
  the button.
- `host_permissions` for `overleaf.com`: so it can read the comments on that page.
