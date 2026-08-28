import { IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateShipmentDto {
  @IsOptional()
  @IsString()
  origin?: string;

  @IsOptional()
  @IsString()
  destination?: string;

  @IsOptional()
  originCoordinates?: { latitude: number; longitude: number };

  @IsOptional()
  destinationCoordinates?: { latitude: number; longitude: number };

  @IsOptional()
  @IsString()
  cargoType?: string;

  @IsOptional()
  @IsString()
  quantity?: string;

  @IsOptional()
  @IsNumber()
  weightTons?: number;

  @IsOptional()
  @IsString()
  truckType?: string;

  @IsOptional()
  @IsString()
  cargoPhotoUri?: string;

  @IsOptional()
  @IsString()
  pickupLabel?: string;

  @IsOptional()
  @IsString()
  pickupAddress?: string;

  @IsOptional()
  @IsNumber()
  pickupLatitude?: number;

  @IsOptional()
  @IsNumber()
  pickupLongitude?: number;

  @IsOptional()
  @IsString()
  destinationLabel?: string;

  @IsOptional()
  @IsString()
  destinationAddress?: string;

  @IsOptional()
  @IsNumber()
  destinationLatitude?: number;

  @IsOptional()
  @IsNumber()
  destinationLongitude?: number;

  @IsOptional()
  @IsString()
  cargoDescription?: string;

  @IsOptional()
  @IsNumber()
  cargoWeightKg?: number;

  @IsOptional()
  @IsNumber()
  cargoValueKobo?: number;

  @IsOptional()
  @IsNumber()
  quotedPriceKobo?: number;

  @IsOptional()
  @IsNumber()
  distanceKm?: number;

  @IsOptional()
  @IsNumber()
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  quoteToken?: string;

  @IsOptional()
  @IsString()
  pickupContactPhone?: string;
}
