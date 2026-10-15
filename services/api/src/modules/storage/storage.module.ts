import { Module } from '@nestjs/common';
import { LocalStorageController } from './local-storage.controller';
import { StorageService } from './storage.service';

/** Private object storage (S3-compatible or encrypted local disk). */
@Module({ controllers: [LocalStorageController], providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
