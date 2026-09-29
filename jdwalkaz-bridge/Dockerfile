FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8040

ENV PORT=8040
ENV REDIS_URL=redis://redis:6379/0
ENV REDPANDA_BROKERS=redpanda:9092
ENV JDWALKAZ_ENDPOINT=https://truffle.leaksnipe.win
ENV JDWALKAZ_ORIGIN=https://wecrypto.leaksnipe.win

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8040"]
