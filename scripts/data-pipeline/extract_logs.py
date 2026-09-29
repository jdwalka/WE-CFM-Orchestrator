import os
import time
import argparse
from datetime import datetime, timezone

import pandas as pd
from google.cloud import bigquery
from confluent_kafka import Consumer, TopicPartition
import redis

# Boundaries as specified:
# Start Boundary: We use the maximum amount of days the system has (set to 0 to capture all available history)
# End Boundary: June 10, 2026 00:00:00 UTC (1781049600)
START_TS = 0
END_TS = 1781049600

def extract_firebase_bigquery(client, dataset, table_prefix):
    print("Extracting Firebase logs from BigQuery...")
    # Using BigQuery to extract logs. We bound the timestamp based on start and end.
    # The actual implementation requires the user's specific table structure.
    # For now, we will query standard timestamp columns.
    query = f"""
        SELECT 
            timestamp_micros(event_timestamp) as event_time,
            event_name,
            user_id
        FROM `{dataset}.{table_prefix}_*`
        WHERE event_timestamp >= {START_TS * 1000000}
          AND event_timestamp < {END_TS * 1000000}
    """
    df = client.query(query).to_dataframe()
    # Normalize to datetime64[ns]
    df['event_time'] = pd.to_datetime(df['event_time'], utc=True)
    df = df.sort_values('event_time').reset_index(drop=True)
    print(f"Extracted {len(df)} rows from Firebase/BigQuery.")
    return df

def extract_kafka(bootstrap_servers, topic):
    print("Extracting Kafka/Redpanda logs...")
    c = Consumer({
        'bootstrap.servers': bootstrap_servers,
        'group.id': 'log_extractor_group',
        'enable.auto.commit': False
    })
    
    # We use offsets_for_times to locate the exact starting offset
    # confluent_kafka expects timestamps in milliseconds
    start_ms = START_TS * 1000
    
    # Let's get the partitions for the topic
    metadata = c.list_topics(topic=topic)
    if topic not in metadata.topics:
        print(f"Topic {topic} not found.")
        return pd.DataFrame(columns=['event_time', 'kafka_payload'])
        
    partitions = metadata.topics[topic].partitions.keys()
    
    search_partitions = [TopicPartition(topic, p, start_ms) for p in partitions]
    start_offsets = c.offsets_for_times(search_partitions)
    
    # Assign partitions manually
    assigned = []
    for tp in start_offsets:
        if tp.offset > 0:
            assigned.append(tp)
        else:
            # If offset is -1, there is no message >= start_ms
            pass
            
    if not assigned:
        print("No messages found in Kafka for the given time range.")
        return pd.DataFrame(columns=['event_time', 'kafka_payload'])
        
    c.assign(assigned)
    
    records = []
    # Poll until we reach END_TS
    end_ms = END_TS * 1000
    while True:
        msg = c.poll(1.0)
        if msg is None:
            # Check if we hit EOF for all partitions? Simple timeout for now.
            break
        if msg.error():
            print(f"Kafka error: {msg.error()}")
            continue
            
        timestamp_type, ts = msg.timestamp()
        if ts >= end_ms:
            # Depending on partition, we might have to keep polling others, but for simplicity:
            pass 
        
        if ts >= start_ms and ts < end_ms:
            records.append({
                'event_time': pd.to_datetime(ts, unit='ms', utc=True),
                'kafka_payload': msg.value().decode('utf-8') if msg.value() else ''
            })
            
    c.close()
    df = pd.DataFrame(records)
    if not df.empty:
        df = df.sort_values('event_time').reset_index(drop=True)
    print(f"Extracted {len(df)} rows from Kafka/Redpanda.")
    return df

def extract_redis(redis_client, stream_key):
    print("Extracting Redis logs...")
    # Redis XRANGE uses ms-based timestamps
    start_ms = START_TS * 1000
    end_ms = END_TS * 1000
    
    records = []
    # Cursor-based pagination with count to avoid OOM
    batch_size = 1000
    current_start = str(start_ms) + "-0"
    end_id = str(end_ms) + "-0"
    
    while True:
        # xrange(name, min, max, count)
        messages = redis_client.xrange(stream_key, min=current_start, max=end_id, count=batch_size)
        if not messages:
            break
            
        for msg_id, payload in messages:
            # msg_id is bytes like b'1780444800000-0'
            ms_ts = int(msg_id.decode('utf-8').split('-')[0])
            # Only include strictly < end_ms if we want to be exact, but the user requested boundaries
            if ms_ts >= end_ms:
                continue
                
            decoded_payload = {k.decode('utf-8'): v.decode('utf-8') for k, v in payload.items()}
            records.append({
                'event_time': pd.to_datetime(ms_ts, unit='ms', utc=True),
                'redis_payload': str(decoded_payload)
            })
            
        # Update current_start to the next ID (increment sequence)
        last_id = messages[-1][0].decode('utf-8')
        ts_part, seq_part = last_id.split('-')
        current_start = f"{ts_part}-{int(seq_part) + 1}"
        
    df = pd.DataFrame(records)
    if not df.empty:
        df = df.sort_values('event_time').reset_index(drop=True)
    print(f"Extracted {len(df)} rows from Redis.")
    return df

def main():
    parser = argparse.ArgumentParser(description='Aggregate 7 days of log data.')
    parser.add_argument('--bq-dataset', type=str, required=True, help='BigQuery dataset (e.g. project.dataset)')
    parser.add_argument('--bq-table-prefix', type=str, required=True, help='BigQuery table prefix (e.g. events)')
    parser.add_argument('--kafka-brokers', type=str, required=True, help='Kafka/Redpanda bootstrap servers')
    parser.add_argument('--kafka-topic', type=str, required=True, help='Kafka topic name')
    parser.add_argument('--redis-host', type=str, required=True, help='Redis host')
    parser.add_argument('--redis-port', type=int, default=6379, help='Redis port')
    parser.add_argument('--redis-stream', type=str, required=True, help='Redis stream key')
    args = parser.parse_args()

    # 1. Firebase/BigQuery
    bq_client = bigquery.Client()
    df_bq = extract_firebase_bigquery(bq_client, args.bq_dataset, args.bq_table_prefix)
    
    # 2. Kafka/Redpanda
    df_kafka = extract_kafka(args.kafka_brokers, args.kafka_topic)
    
    # 3. Redis
    r = redis.Redis(host=args.redis_host, port=args.redis_port, db=0)
    df_redis = extract_redis(r, args.redis_stream)
    
    # Ensure all DataFrames are sorted by event_time before merge_asof
    if not df_bq.empty:
        df_bq = df_bq.sort_values('event_time')
    if not df_kafka.empty:
        df_kafka = df_kafka.sort_values('event_time')
    if not df_redis.empty:
        df_redis = df_redis.sort_values('event_time')

    print("Performing causal alignment (pandas.merge_asof)...")
    
    # Base dataframe to merge onto (usually the one with highest resolution or primary events)
    # Let's assume Firebase (BigQuery) is the primary telemetry timeline
    if not df_bq.empty:
        final_df = df_bq
        
        if not df_kafka.empty:
            final_df = pd.merge_asof(
                final_df, 
                df_kafka, 
                on='event_time', 
                direction='backward', 
                tolerance=pd.Timedelta('5s')
            )
            
        if not df_redis.empty:
            final_df = pd.merge_asof(
                final_df, 
                df_redis, 
                on='event_time', 
                direction='backward', 
                tolerance=pd.Timedelta('5s')
            )
            
        print(f"Final aligned dataset has {len(final_df)} rows.")
        
        # Save output to BigQuery as requested
        table_id = f"{args.bq_dataset}.aggregated_logs_7d"
        print(f"Saving to BigQuery table: {table_id}")
        
        job_config = bigquery.LoadJobConfig(
            write_disposition="WRITE_TRUNCATE",
        )
        job = bq_client.load_table_from_dataframe(
            final_df, table_id, job_config=job_config
        )
        job.result()  # Wait for the job to complete.
        print(f"Loaded {job.output_rows} rows into {table_id}.")
        
    else:
        print("Base BigQuery dataframe is empty. Nothing to merge.")

if __name__ == '__main__':
    main()
