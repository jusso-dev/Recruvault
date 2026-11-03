# Test-only browser driver for the Compose install proof. Never deploy this.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
# certutil adds the proof CA to Chromium's NSS trust store.
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*
WORKDIR /proof
# Matches the browsers baked into the base image. playwright-core has no dependencies.
RUN npm init -y >/dev/null && npm install --no-audit --no-fund --save-exact playwright-core@1.64.0
COPY entrypoint.sh driver.mjs ./
# The state volume is initialised from this directory, so it is owned by the
# unprivileged browser user that ships with the Playwright image.
RUN mkdir /state && chown pwuser:pwuser /state
USER pwuser
ENTRYPOINT ["sh", "/proof/entrypoint.sh"]
