import { Module } from '@nestjs/common';
import { OcrController } from './ocr.controller';
import { OcrService } from './ocr.service';
import { OcrProviders } from './providers';
import { OcrErasure } from './ocr.erasure';

/** AI document assistant (OCR + extraction with mandatory human review). Uses the vault through the global DocumentsModule. */
@Module({ controllers: [OcrController], providers: [OcrProviders, OcrService, OcrErasure], exports: [OcrProviders, OcrService] })
export class OcrModule {}
