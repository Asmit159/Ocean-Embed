/**
 * Coordinate Validation Utility
 * Validates that latitude and longitude conform to the required 5-degree grid system:
 * - Latitude: [-90.0, 90.0] and must be a multiple of 5.
 * - Longitude: [-180.0, 180.0] and must be a multiple of 5.
 */

export function isMultipleOfFive(value) {
  const remainder = Math.abs(value % 5);
  // Account for IEEE 754 floating point imprecision
  return remainder < 1e-5 || Math.abs(remainder - 5) < 1e-5;
}

export function validateCoordinates(latRaw, lonRaw) {
  if (latRaw === undefined || lonRaw === undefined || latRaw === '' || lonRaw === '') {
    return {
      isValid: false,
      status: 422,
      errorCode: 'INVALID_COORDINATES',
      message: 'Both lat and lon query parameters are required.',
    };
  }

  const lat = parseFloat(latRaw);
  const lon = parseFloat(lonRaw);

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return {
      isValid: false,
      status: 422,
      errorCode: 'INVALID_COORDINATES',
      message: 'Coordinates must be valid floating-point numbers.',
    };
  }

  if (lat < -90 || lat > 90) {
    return {
      isValid: false,
      status: 422,
      errorCode: 'INVALID_COORDINATES',
      message: `Latitude (${lat}) out of valid range [-90, 90].`,
    };
  }

  if (lon < -180 || lon > 180) {
    return {
      isValid: false,
      status: 422,
      errorCode: 'INVALID_COORDINATES',
      message: `Longitude (${lon}) out of valid range [-180, 180].`,
    };
  }

  if (!isMultipleOfFive(lat) || !isMultipleOfFive(lon)) {
    return {
      isValid: false,
      status: 422,
      errorCode: 'INVALID_COORDINATES',
      message: `Coordinates must be strictly aligned to 5-degree grid intervals (lat: ${lat}, lon: ${lon}).`,
    };
  }

  return {
    isValid: true,
    lat,
    lon,
  };
}
