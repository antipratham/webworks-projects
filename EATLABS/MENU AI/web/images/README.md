# Dish images

Drop image files here at deployment. They are served at `/images/<filename>`.

The convention the backend should follow:

1. Name each file after the dish id: `M001.jpg`, `M134.webp`.
2. Set that item's `image_url` in the menu JSON to `/images/M001.jpg`.

An absolute CDN URL works too - `image_url` is passed through to the client
unchanged, so `https://cdn.example.com/dishes/m001.webp` is equally valid and
needs nothing in this folder.

`image_url: null` (the current state of all 200 items) is not an error. The client
renders a placeholder tile carrying the dish's initials and its veg / non-veg
marker, so a menu with no photography still reads correctly.

Served extensions: png, jpg, jpeg, webp, avif, gif, svg. Filenames only - no
subdirectories, and nothing that looks like a path.

Suggested sizes: about 320x320 for the list thumbnail, 800x500 for the sheet at
the top of a dish. The same file is used for both, so upload the larger one.

## Checking the wiring

`_sample.svg` is in this folder for that. Set any item's `image_url` to
`/images/_sample.svg` in the menu JSON, reload, and that dish should show a red
tile where its placeholder initials were. Set it back to `null` afterwards.
