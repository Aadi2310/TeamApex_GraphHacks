FROM python:3.12-slim AS runtime-dependencies
WORKDIR /install
COPY requirements.lock ./requirements.lock
RUN pip install --no-cache-dir --require-hashes --prefix=/install -r requirements.lock

FROM python:3.12-slim AS test
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
WORKDIR /app
COPY requirements-dev.lock ./requirements-dev.lock
RUN pip install --no-cache-dir --require-hashes -r requirements-dev.lock \
    && groupadd --system app \
    && useradd --system --gid app --home-dir /app app
COPY --chown=app:app app ./app
COPY --chown=app:app tests ./tests
USER app
CMD ["pytest", "tests"]

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app --home-dir /app app
COPY --from=runtime-dependencies /install /usr/local
COPY --chown=app:app app ./app
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
