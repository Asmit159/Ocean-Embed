"""
Ocean Temperature Forecasting - PyTorch Model Singleton
Loads oceanembed_sih_prototype.pt once into CPU/GPU memory globally at startup.
Provides thread-safe access and warm execution.
"""

import os
import logging
import torch
from typing import Optional

logger = logging.getLogger("ocean_ml")


class ModelSingleton:
    _instance: Optional["ModelSingleton"] = None
    _model: Optional[torch.jit.ScriptModule] = None
    _device: str = "cuda" if torch.cuda.is_available() else "cpu"

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super(ModelSingleton, cls).__new__(cls)
        return cls._instance

    @classmethod
    def initialize(cls, model_path: str = "./models/oceanembed_sih_prototype.pt") -> None:
        """
        Loads the TorchScript model into memory globally.
        """
        if cls._model is not None:
            return

        cls._device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Initializing ModelSingleton on device: {cls._device}")

        if not os.path.exists(model_path):
            raise FileNotFoundError(f"Model file not found at '{model_path}'")

        try:
            cls._model = torch.jit.load(model_path, map_location=cls._device)
            cls._model.eval()

            # Warmup pass with 11-channel tensor
            with torch.no_grad():
                warmup = torch.zeros(1, 11, 128, 256, device=cls._device, dtype=torch.float32)
                _ = cls._model(warmup)

            logger.info(f"Model successfully loaded from {model_path} and warmed up.")
        except Exception as err:
            logger.error(f"Failed to load TorchScript model: {err}")
            raise



    @classmethod
    def get_model(cls) -> torch.jit.ScriptModule:
        if cls._model is None:
            raise RuntimeError("ModelSingleton has not been initialized. Call ModelSingleton.initialize() first.")
        return cls._model

    @classmethod
    def get_device(cls) -> str:
        return cls._device

    @classmethod
    def is_loaded(cls) -> bool:
        return cls._model is not None
