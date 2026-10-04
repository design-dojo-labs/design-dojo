# Design Dojo website

The `site/` directory is a standalone, responsive product website. It explains the local studio and includes an illustrative, interactive preview. It does not run the studio or call its API. No build or npm dependencies are needed; asset paths work under a GitHub Pages repository subpath.

## Preview locally

From the repository root:

```sh
python3 -m http.server 4320 --bind 127.0.0.1 --directory site
```

Open http://127.0.0.1:4320. Google Fonts is optional; system fonts are used if unavailable.

## Publish on GitHub Pages

1. Push this project, including `site/` and `.github/workflows/pages.yml`, to the intended GitHub repository.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Run **Deploy Design Dojo website** from the Actions tab, or push a change to `site/` on `main`. If your default branch has a different name, update `branches` in the workflow first.
4. Open the URL reported by the deployment job. For a normal project repository, this is `https://OWNER.github.io/REPOSITORY/`.

Only `site/` is uploaded as the Pages artifact. The local application, practice data, and server are not part of the website artifact.

The workflow follows GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Editing

- `site/index.html`: product copy, setup commands, preview content, and FAQ.
- `site/styles.css`: responsive layout, colors, and decorative orbital illustration.
- `site/script.js`: accessible preview tabs and copying setup commands.
- `site/favicon.svg`: site icon.

The preview is explicitly illustrative. Keep its descriptions and the problem counts in sync with the application. The setup instructions clone https://github.com/design-dojo-labs/design-dojo. The intended Pages URL is https://design-dojo-labs.github.io/design-dojo/.
