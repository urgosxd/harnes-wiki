# Two stages: build the static bundle, then serve it from nginx.
FROM node:22.23.2-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

# Typecheck and build. A type error fails the image, not the browser.
RUN npx tsc --noEmit && npx vite build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# nginx:alpine ships a health endpoint only if configured, so this checks the page.
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
