# UDA Modified Tool

The repository contains the complete application source and supporting assets.

## Application folders

- `databridge/frontend` — React web interface
- `databridge/backend` — Node.js API and data-processing service
- `databridge/database` — database setup scripts
- `databridge/nginx` — virtual-machine reverse-proxy configuration
- `databridge/scripts` — deployment utilities

## Launch with Docker

1. Copy `databridge/backend/.env.example` to `databridge/backend/.env` and enter the required service credentials.
2. From the `databridge` directory, run:

   ```bash
   docker compose up --build
   ```

3. Open <http://localhost>.

## Launch pipeline

The **Launch application** workflow runs automatically for changes to `main` and can also be started manually from the GitHub Actions page. It installs dependencies, builds the web application, launches the complete Docker stack, and verifies the API and web interface.

For configuration and non-Docker deployment options, see [`databridge/README.md`](databridge/README.md).
