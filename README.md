# evacsim

## Deploying on Dokploy

Create an Application in Dokploy and set **Build Type** to **Dockerfile**, then configure a domain to the container port `5050` with HTTPS enabled.

The image builds the Vite frontend and serves it with nginx. The simulation runs in the browser from the data committed in `public/data`, so there is no server state, volume, or replica limit. To regenerate that data, run `python prepare.py` locally and commit the result.
