"""
Seed script for Ocean Data Lake and PostgreSQL Metadata Index.
Populates PostgreSQL ocean_forecast_index and uploads sample chunked (7, 101, 241) .npz
tensors to MinIO object storage.
"""

import datetime
import io
import os
import boto3
from botocore.client import Config
import numpy as np
import psycopg2

POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "5432"))
POSTGRES_DB = os.getenv("POSTGRES_DB", "ocean_db")
POSTGRES_USER = os.getenv("POSTGRES_USER", "ocean_user")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "ocean_secret_pass")

MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "localhost:9000")
MINIO_ACCESS_KEY = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.getenv("MINIO_SECRET_KEY", "minioadmin")
MINIO_BUCKET = os.getenv("MINIO_BUCKET", "ocean-data")
MINIO_USE_SSL = os.getenv("MINIO_USE_SSL", "false").lower() == "true"


def seed_database_and_lake():
    print(f"Connecting to MinIO at {MINIO_ENDPOINT}...")
    s3_protocol = "https" if MINIO_USE_SSL else "http"
    s3 = boto3.client(
        "s3",
        endpoint_url=f"{s3_protocol}://{MINIO_ENDPOINT}",
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        verify=False,
    )

    # Ensure bucket exists
    try:
        s3.create_bucket(Bucket=MINIO_BUCKET)
        print(f"Created MinIO bucket: {MINIO_BUCKET}")
    except Exception:
        print(f"Bucket {MINIO_BUCKET} already exists or accessible.")

    # Connect to PostgreSQL
    print(f"Connecting to PostgreSQL at {POSTGRES_HOST}:{POSTGRES_PORT}...")
    conn = psycopg2.connect(
        host=POSTGRES_HOST,
        port=POSTGRES_PORT,
        dbname=POSTGRES_DB,
        user=POSTGRES_USER,
        password=POSTGRES_PASSWORD,
    )
    cur = conn.cursor()

    # Create table if not exists
    cur.execute("""
    CREATE TABLE IF NOT EXISTS ocean_forecast_index (
        id SERIAL PRIMARY KEY,
        forecast_date DATE UNIQUE NOT NULL,
        s3_key VARCHAR(255) NOT NULL,
        data_format VARCHAR(20) DEFAULT 'npz',
        tensor_shape VARCHAR(50) DEFAULT '(7, 101, 241)',
        file_size_bytes BIGINT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_forecast_date ON ocean_forecast_index(forecast_date);
    """)
    conn.commit()

    # Generate dates across sample window
    base_date = datetime.date(2024, 6, 1)
    num_days = 14

    print(f"Seeding {num_days} sample days of chunked physical tensors...")
    for i in range(num_days):
        curr_date = base_date + datetime.timedelta(days=i)
        date_str = curr_date.strftime("%Y-%m-%d")
        s3_key = f"physical_tensors/{curr_date.year}/{curr_date.month:02d}/{curr_date.day:02d}/ocean_tensor.npz"

        # Synthesize realistic (7, 101, 241) array
        y_coords = np.linspace(-1, 1, 101).reshape(1, 101, 1)
        x_coords = np.linspace(-1, 1, 241).reshape(1, 241)
        lat_factor = 28.0 * (1.0 - (y_coords ** 2))

        raw = np.zeros((7, 101, 241), dtype=np.float32)
        # Seasonal perturbation factor
        seasonal = np.sin(2 * np.pi * curr_date.timetuple().tm_yday / 365.25)
        raw[0] = lat_factor + 2.0 * np.sin(x_coords * 3.14) + seasonal * 1.5
        raw[1] = 35.0 + 1.2 * np.cos(y_coords * 3.14)
        raw[2] = 0.2 * np.sin(y_coords * 6.28)
        raw[3] = 0.15 * np.cos(x_coords * 6.28)
        raw[4] = 1013.25 + 5.0 * np.sin(x_coords)
        raw[5] = 200.0 * np.maximum(0, 1.0 - np.abs(y_coords))
        raw[6] = 0.08 + 0.02 * np.random.randn(101, 241)

        # Save to compressed .npz buffer
        buf = io.BytesIO()
        np.savez_compressed(buf, tensor=raw)
        buf.seek(0)
        file_bytes = buf.getvalue()

        # Upload to MinIO
        s3.put_object(
            Bucket=MINIO_BUCKET,
            Key=s3_key,
            Body=file_bytes,
            ContentType="application/octet-stream",
        )

        # Index in PostgreSQL
        cur.execute("""
            INSERT INTO ocean_forecast_index (forecast_date, s3_key, data_format, tensor_shape, file_size_bytes)
            VALUES (%s, %s, 'npz', '(7, 101, 241)', %s)
            ON CONFLICT (forecast_date) DO UPDATE
            SET s3_key = EXCLUDED.s3_key, file_size_bytes = EXCLUDED.file_size_bytes;
        """, (date_str, s3_key, len(file_bytes)))

    conn.commit()
    cur.close()
    conn.close()
    print("Database and MinIO lake seeding successfully completed.")


if __name__ == "__main__":
    seed_database_and_lake()
