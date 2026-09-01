# Gestion Scolaire — Serveur de synchronisation (Node/Express) pour Render
FROM node:20-alpine

WORKDIR /app

# Dépendances d'abord (meilleur cache distant)
COPY package*.json ./
RUN npm install --omit=dev

# Code applicatif
COPY server.js ./

# Volume pour le registre persistant (posts.json)
VOLUME ["/app/data"]

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server.js"]
