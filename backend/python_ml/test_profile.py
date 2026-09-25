import asyncio
import uuid
import sys
from main import run_profile_task, TASK_STORE
from model_singleton import ModelSingleton
from services.live_ocean_data import authenticate_apis

async def main():
    ModelSingleton.initialize()
    authenticate_apis()
    task_id = str(uuid.uuid4())
    print(f"Running task {task_id}")
    try:
        await run_profile_task(task_id, 10.0, 85.0, "2024-12-15", "test-trace")
        print(f"Task result: {TASK_STORE[task_id]['status']}")
        if TASK_STORE[task_id]['status'] == 'failed':
            print(f"Task error: {TASK_STORE[task_id].get('error')}")
    except Exception as e:
        print(f"Caught exception: {e}")

if __name__ == "__main__":
    asyncio.run(main())
