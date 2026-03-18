FROM docker.io/oven/bun:1
RUN mkdir /app
WORKDIR /app
CMD ["bun", "run", "dev", "--", "--host", "0.0.0.0"]
