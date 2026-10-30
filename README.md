# RRQI Explorer

A GitHub Pages–ready **Running Route Quality Index (RRQI) research viewer**, adapted from Meta's MIT-licensed [Mapillary API Demo](https://github.com/mapillary/api-demo). It combines Mapillary images with on-demand **real browser-side computer vision** and photo-location **open geographic data**.

This is a **research prototype**. It displays predictions and contextual measurements but **does not produce or validate an RRQI score**. You must determine and validate your own running-safety, runnability, visibility, and shade metrics.

## Features

- Explore geolocated Mapillary imagery and sequences, image metadata, existing Mapillary detections and map features, and the upstream demo's search/filter tools.
- **RRQI Vision:** toggle **Original**, **Semantic**, **Objects**, or **Both**. Semantic segmentation uses [SegFormer B0 Cityscapes](https://huggingface.co/Xenova/segformer-b0-finetuned-cityscapes-1024-1024); object detection uses [YOLOS Tiny](https://huggingface.co/Xenova/yolos-tiny). Both run locally in your browser with [Transformers.js](https://huggingface.co/docs/transformers.js/index) and WASM on demand. Models download from Hugging Face the first time and may be cached. No AI API token is needed.
- The segmentation view offers separate colors for road, sidewalk, vegetation, sky, vehicles, and other classes. The object view draws confidence-labeled bounding boxes. Image pixel shares are displayed (not route-length percentages).
- **RRQI Data:** elevation at photo GPS coordinates, a nearby-road exposure **proxy** (OSM class/speed/lanes), and nearby Caltrans **AADT** when a count station is within 80 meters. Live volume and actual run-time congestion are **not** available.
- **Local photo mode:** upload your own photo, parse GPS EXIF when the optional `exifr` library is available, or enter coordinates manually. The sample photo is your supplied running-route example.
- Export the viewed image analysis as PNG and visited photo metadata as JSON/CSV.
- GitHub Pages static hosting: HTML/CSS/JavaScript only. No server or paid API keys required for public datasets.

## Deploy to GitHub Pages

1. **Unzip** `RRQI-Explorer-GitHub-Pages.zip`.
2. Create a new **public** GitHub repository (for example `rrqi-explorer`).
3. Upload the **files inside** the `RRQI-Explorer` folder to the repository's **root**: `index.html`, `style.css`, `app.js`, `rrqi.js`, `rrqi-logo.svg`, `sample-running-street.jpg`, `README.md`, and `LICENSE`.
4. Go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, **main**, **/(root)**, then save.
5. Open `https://YOUR_USERNAME.github.io/rrqi-explorer/` once GitHub finishes publishing. GitHub Pages automatically supplies HTTPS.
6. Search for a place, select a Mapillary image, then click **RRQI Vision** or **RRQI Data** on the right. Or click **Open RRQI Lab** in the header to upload your own photo or view the sample without selecting a Mapillary image. Press **Semantic**, **Objects** or **Both** to run analysis.

**Don't upload a private or secret token to a public GitHub repository.** The included upstream demo contains its documented shared public *demo token* in `app.js` for convenience. You can instead click **Change access token** in the app and paste your own Mapillary API token at runtime. Any token used by a client-side GitHub Pages site is exposed to the browser; use only client-safe credentials.

## How to use the RRQI Vision tab

1. Click a green Mapillary sequence or dot. The viewer opens at the selected image.
2. Click **RRQI Vision** and choose **Semantic** (pixel classifications), **Objects** (object boxes), or **Both**. First use downloads the chosen models and can take time on slow devices.
3. Adjust opacity and **Save annotated PNG**, if desired.
4. If the remote image host does not allow browser CORS, you may still view it in the original Mapillary Viewer tab, but the separate AI pipeline **cannot legally read its pixels in a canvas**. Download an image you are entitled to process or use **Use your own photo**. This fallback is intentional—there is no proxy or CORS bypass.
5. Open **RRQI Data** for coordinates, elevation, nearby road context and possible AADT. Uploading a photo without GPS requires manual coordinates or the **Use map center** option (which is an approximation).
6. Use **Export JSON** or **Export CSV** to save records of the images you've opened during the current browser visit. This prototype does **not** store history in a backend.

### Research interpretation

| RRQI characteristic | Current prototype support | What is not measured yet |
| --- | --- | --- |
| Running facility | Semantic mask may identify sidewalk / road | Continuity over an entire route |
| Buffer from vehicles | Detected vehicles and nearest mapped road | Actual physical setback in meters |
| Signs / crosswalks | Existing Mapillary detection labels; select image view | Crosswalk count per km and crossing protection |
| Surface type | Road/sidewalk/terrain segmentation classes | Fine-grained concrete vs asphalt vs gravel reliably |
| Surface condition | Some visible objects may be detected | Pothole/crack counts or severity |
| Path width | Sidewalk pixels as visualization | Reliable unobstructed width in meters |
| Lighting | Existing map imagery / detection labels | Fixture inventory, actual night illumination |
| Vegetation & shade | Vegetation semantic pixels | Overhead canopy along route and actual shade exposure |

**Important:** SegFormer Cityscapes is trained for general road scenes, **not** your custom RRQI categories or labels. Pixel percentages are **visible-image-area fractions**, not surface-area estimates, percentages of distance shaded, or safety ratings. YOLOS Tiny's COCO object classes are not specifically trained to detect cracks or all road infrastructure.

## Geographic data sources and limitations

**Elevation**: [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api), using Copernicus DEM GLO-90 (~90 m resolution), in meters. CORS-friendly and free for noncommercial research with attribution. It is a broad terrain estimate; do **not** calculate precise grade from adjacent photos separated by 3 m. For route-level grade research use a higher-resolution elevation source such as USGS 3DEP or surveyed GPS elevation.

**Road exposure proxy**: [OpenStreetMap](https://www.openstreetmap.org/copyright) via [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API). Search for motor roads near the selected coordinates; show a *qualitative heuristic* derived from OSM `highway`, `maxspeed`, and `lanes` tags. Missing tags or no road found are **not** evidence of safety. Free public Overpass instances can rate-limit or be unavailable. This proxy is **not a traffic-volume count**.

**Measured highway traffic**: [Caltrans Annual Average Daily Traffic (AADT)](https://data.ca.gov/@caltrans/annual-average-daily-traffic) published via the ArcGIS FeatureServer. Query nearby stations, only display if one is within 80 m. Data are for **California state highways**, not all city streets, and the nearby station **could count a different road**. `BACK_AADT` and `AHEAD_AADT` are shown as available; they are not summed. AADT is a *historical average daily traffic count*, **not a live congestion metric**. City of San Luis Obispo publishes some local counts on [its traffic data page](https://www.slocity.org/government/department-directory/public-works/programs-and-services/transportation-planning-and-engineering/traffic-data), but no suitable cross-origin photo-level public API is integrated here.

**Mapillary imagery & detections**: [Mapillary API](https://www.mapillary.com/developer), original [Mapillary API Demo](https://mapillary.github.io/api-demo/). Image use and attribution are subject to the [Mapillary Terms of Use](https://www.mapillary.com/terms). The original Viewer tab preserves author attribution; show original contributor/source attribution when sharing any derivative image.

**Computer vision models**: [SegFormer Cityscapes](https://huggingface.co/Xenova/segformer-b0-finetuned-cityscapes-1024-1024), [YOLOS Tiny](https://huggingface.co/Xenova/yolos-tiny), [Transformers.js](https://huggingface.co/docs/transformers.js/index). Check the model repositories' license and attribution terms for research publications.

## Files

- `index.html`: map/viewer, tabs, controls and metadata panels.
- `style.css`: original demo CSS plus responsive RRQI dashboard CSS.
- `app.js`: Mapillary API demo, with a small `rrqi:imagechange` event bridge and San Luis Obispo start view.
- `rrqi.js`: RRQI Vision model inference, overlays, image import, elevation / OSM / Caltrans lookups, metadata export.
- `rrqi-logo.svg`: RRQI branding.
- `sample-running-street.jpg`: user-supplied test image.
- `LICENSE`: original MIT license (Meta). RRQI additions also released under MIT.

## Local development and tests

Run `python3 -m http.server 8000` from the repository root and open `http://localhost:8000` on your computer, or upload to GitHub Pages. Most browser features require a network connection for remote maps, data and models. On an iPhone, use the GitHub Pages HTTPS URL.

JavaScript syntax can be checked with:

```sh
node --check app.js
node --check rrqi.js
```

This project was statically checked but **the Mapillary remote image CORS behavior, third-party API responses, and the downloaded AI model inference have not been end-to-end tested on an iPhone**. Test with several known images before using the outputs as research observations. This is an exploratory data viewer, not a Mapillary replacement or a recording app.

## Acknowledgements / licenses

Adapted from the [Mapillary API Demo](https://github.com/mapillary/api-demo), copyright Meta Platforms, Inc. (MIT). MapillaryJS/MapLibre/Mapillary map data and imagery have separate licenses or terms. Open-Meteo / Copernicus DEM, OpenStreetMap contributors, Caltrans, and open-source model authors are credited above and in the RRQI Data tab.
