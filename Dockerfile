FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libgdal-dev \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5050

CMD ["sh", "-c", "if [ ! -f data/households.geojson ]; then python prepare.py; fi && python server.py --port 5050"]