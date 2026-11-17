# Not the deployment path. The target host (Ubuntu 24.04, user `sungjung`) has no
# docker or podman, so the real deployment is `sh start.sh` under the user's home
# directory in a tmux session. This file exists so the gateway can be built and
# exercised in a container elsewhere; it is not used on that host and the README
# does not tell anyone to use it there.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY lib ./lib
COPY stub ./stub
COPY server.mjs ./
COPY gateway.config.example.json ./

# Bind stays on loopback inside the container; reach it with a port mapping and
# treat that as a deliberate exposure decision.
EXPOSE 8000
USER node
CMD ["node", "server.mjs", "--config", "gateway.config.example.json"]
