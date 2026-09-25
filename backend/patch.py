import os

file_path = r'C:\OceanEmbed_backend\python_ml\main.py'
with open(file_path, 'r') as f:
    content = f.read()

target = '''    except Exception as e:
        logger.error(f"Async task {task_id} failed: {e}", extra={"trace_id": trace_id})
        TASK_STORE[task_id]["status"] = "failed"
        TASK_STORE[task_id]["error"] = str(e)'''

replacement = '''    except Exception as e:
        import traceback
        traceback.print_exc()
        logger.error(f"Async task {task_id} failed: {e}", extra={"trace_id": trace_id})
        TASK_STORE[task_id] = {
            "status": "failed",
            "progress": 100,
            "error": str(e)
        }'''

if target in content:
    content = content.replace(target, replacement)
    with open(file_path, 'w') as f:
        f.write(content)
    print("Patched main.py successfully.")
else:
    print("Target not found. Existing except block:")
    print(content[content.find("except Exception as e:"):content.find("except Exception as e:")+300])
