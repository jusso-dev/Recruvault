FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
WORKDIR /mock
COPY server.mjs ./
USER node
EXPOSE 8025
CMD ["node", "server.mjs"]
