import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { DATA_URL_MAX } from '../../common/input-rules';

export class CreateShipmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  origin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  destination?: string;

  @IsOptional()
  originCoordinates?: { latitude: number; longitude: number };

  @IsOptional()
  destinationCoordinates?: { latitude: number; longitude: number };

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Keep the commodity under 200 characters.' })
  cargoType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Keep the quantity under 100 characters.' })
  quantity?: string;

  @IsOptional()
  @IsNumber()
  weightTons?: number;

  @IsOptional()
  @IsNumber()
  volumeM3?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Keep the truck type under 100 characters.' })
  truckType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(DATA_URL_MAX)
  cargoPhotoUri?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  pickupLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  pickupAddress?: string;

  @IsOptional()
  @IsNumber()
  pickupLatitude?: number;

  @IsOptional()
  @IsNumber()
  pickupLongitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  destinationLabel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  destinationAddress?: string;

  @IsOptional()
  @IsNumber()
  destinationLatitude?: number;

  @IsOptional()
  @IsNumber()
  destinationLongitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
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
  @MaxLength(8192)
  quoteToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30, { message: 'Enter a pickup contact phone number of up to 30 characters.' })
  pickupContactPhone?: string;

  // The same value on every retry of one booking attempt, so a retry after a lost
  // response returns the shipment already created instead of booking a second one.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clientRequestId?: string;
}
