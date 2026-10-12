# evacsim

## Deploying on Dokploy

Create an Application in Dokploy and set **Build Type** to **Dockerfile**. Add a named volume mounted at `/app/data`, then configure a domain to the container port `5050` with HTTPS enabled.

The first boot takes several minutes while `prepare.py` downloads and generates the simulation data. Expect a `502` response until preparation finishes. The container needs about 2 GB of RAM.

Run exactly **one replica**. The simulation state is a global shared by all visitors, so multiple replicas would give visitors different worlds.