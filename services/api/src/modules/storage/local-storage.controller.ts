import { Controller, Get, HttpCode, Param, Put, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../common/auth/access';
import { AppError, Errors } from '../../common/errors';
import { RateLimit } from '../../common/rate-limit';
import { StorageObjectNotFound, UploadRejected } from './local.driver';
import { StorageService } from './storage.service';
import { contentDisposition } from './storage.types';

const linkExpired = (message = 'This link has expired or is not valid. Please request a new one.') => Errors.forbidden('LINK_EXPIRED', message);

/**
 * Serves the local driver's signed upload / download URLs. The routes are
 * public on purpose: the signed, expiring ticket in the path IS the capability
 * (exactly like an S3 presigned URL). They do not exist when STORAGE_DRIVER=s3.
 */
@ApiTags('Storage')
@Controller('storage/local')
export class LocalStorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @RateLimit({ name: 'storage-upload', limit: 120, windowSeconds: 60 })
  @Put('upload/:token')
  @HttpCode(200)
  @ApiOperation({ summary: 'Local storage driver: upload the bytes for an upload intent (raw body)' })
  async upload(@Param('token') token: string, @Req() req: Request) {
    const driver = this.storage.local;
    if (!driver) throw Errors.notFound('Upload link');
    const ticket = driver.openUploadTicket(token);
    if (!ticket) throw linkExpired();
    try {
      // The body is read as a stream: only JSON / form bodies are parsed by the framework,
      // and those content types are never valid here.
      await driver.receiveUpload(ticket, req, { contentType: req.header('content-type'), contentLength: req.header('content-length') });
    } catch (e) {
      if (!(e instanceof UploadRejected)) throw e;
      if (e.code === 'ALREADY_USED') throw linkExpired(e.message);
      if (e.code === 'TOO_LARGE') {
        // Do not keep reading an oversized body: answer, then drop the connection.
        req.res?.setHeader('Connection', 'close');
        req.res?.once('finish', () => req.destroy());
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', e.message);
      }
      if (e.code === 'TYPE_MISMATCH') throw new AppError(415, 'UPLOAD_TYPE_MISMATCH', e.message);
      throw Errors.badRequest(e.code === 'SIZE_MISMATCH' ? 'UPLOAD_SIZE_MISMATCH' : 'UPLOAD_ABORTED', e.message);
    }
    return { status: 'UPLOADED' as const };
  }

  @Public()
  @RateLimit({ name: 'storage-download', limit: 240, windowSeconds: 60 })
  @Get('download/:token')
  @ApiExcludeEndpoint()
  async download(@Param('token') token: string, @Res() res: Response) {
    const driver = this.storage.local;
    if (!driver) throw Errors.notFound('Download link');
    const ticket = driver.openDownloadTicket(token);
    if (!ticket) throw linkExpired();
    let content: Buffer;
    try {
      content = await driver.getBuffer(ticket.key);
    } catch (e) {
      if (e instanceof StorageObjectNotFound) throw Errors.notFound('File');
      throw e;
    }
    res.status(200).set({
      'Content-Type': ticket.ct,
      'Content-Length': String(content.length),
      'Content-Disposition': contentDisposition(ticket.disp, ticket.fn),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  }
}
