import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  createGeneratedDocumentSchema, documentTemplateSchema, generatedDocumentQuery, handOverDocumentSchema, queryBool, signDocumentSchema, updateDocumentTemplateSchema, updateGeneratedDocumentSchema,
  voidDocumentSchema, z,
} from '@typease/validation';
import { Permissions, Public } from '../../common/auth/access';
import { RateLimit } from '../../common/rate-limit';
import { dto } from '../../common/zod';
import { PaperworkService } from './paperwork.service';

class TemplateDto extends dto(documentTemplateSchema) {}
class UpdateTemplateDto extends dto(updateDocumentTemplateSchema) {}
class TemplatesQuery extends dto(z.object({ includeInactive: queryBool })) {}
class CreateDto extends dto(createGeneratedDocumentSchema) {}
class UpdateDto extends dto(updateGeneratedDocumentSchema) {}
class ListDto extends dto(generatedDocumentQuery) {}
class SignDto extends dto(signDocumentSchema) {}
class HandOverDto extends dto(handOverDocumentSchema) {}
class VoidDto extends dto(voidDocumentSchema) {}

function sendPdf(res: Response, file: { filename: string; content: Buffer }) {
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Content-Length', String(file.content.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.content);
}

@ApiTags('Ready-made documents')
@ApiBearerAuth()
@Controller('paperwork')
export class PaperworkController {
  constructor(private readonly paperwork: PaperworkService) {}

  @Permissions('paperwork.read', 'paperwork.manage', 'paperwork.templates')
  @Get('templates')
  templates(@Query() q: TemplatesQuery) {
    return this.paperwork.templates(q.includeInactive ?? false);
  }
  @Permissions('paperwork.templates')
  @Post('templates')
  createTemplate(@Body() body: TemplateDto) {
    return this.paperwork.createTemplate(body);
  }
  @Permissions('paperwork.templates')
  @Patch('templates/:id')
  updateTemplate(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateTemplateDto) {
    return this.paperwork.updateTemplate(id, body);
  }

  @Permissions('paperwork.read', 'paperwork.manage')
  @Get('documents')
  list(@Query() query: ListDto) {
    return this.paperwork.list(query);
  }
  @Permissions('paperwork.manage')
  @Post('documents')
  @ApiOperation({ summary: 'Draft a document from a template and the customer\'s record' })
  create(@Body() body: CreateDto) {
    return this.paperwork.create(body);
  }
  @Permissions('paperwork.read', 'paperwork.manage')
  @Get('documents/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.paperwork.get(id);
  }
  @Permissions('paperwork.manage')
  @Patch('documents/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDto) {
    return this.paperwork.update(id, body.values);
  }
  @Permissions('paperwork.manage')
  @Delete('documents/:id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.paperwork.removeDraft(id);
  }
  @Permissions('paperwork.manage')
  @Post('documents/:id/issue')
  @HttpCode(200)
  @ApiOperation({ summary: 'Freeze the text; the signer is sent the signing link when a signature is needed' })
  issue(@Param('id', ParseUUIDPipe) id: string) {
    return this.paperwork.issue(id);
  }
  @Permissions('paperwork.manage')
  @Get('documents/:id/sign-link')
  async signLink(@Param('id', ParseUUIDPipe) id: string) {
    await this.paperwork.get(id);
    return { link: await this.paperwork.signLink(id) };
  }
  @Permissions('paperwork.manage')
  @Post('documents/:id/sign')
  @HttpCode(200)
  @ApiOperation({ summary: 'The signer signs on the centre\'s screen' })
  sign(@Param('id', ParseUUIDPipe) id: string, @Body() body: SignDto) {
    return this.paperwork.signAtCounter(id, body);
  }
  @Permissions('paperwork.manage')
  @Post('documents/:id/hand-over')
  @HttpCode(200)
  handOver(@Param('id', ParseUUIDPipe) id: string, @Body() body: HandOverDto) {
    return this.paperwork.handOver(id, body.handedOverTo, body.note);
  }
  @Permissions('paperwork.manage')
  @Post('documents/:id/void')
  @HttpCode(200)
  void(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoidDto) {
    return this.paperwork.void(id, body.reason);
  }
  @Permissions('paperwork.read', 'paperwork.manage')
  @Get('documents/:id/pdf')
  @ApiProduces('application/pdf')
  async pdf(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    sendPdf(res, await this.paperwork.pdf(id));
  }
}

/** The signing link: read, sign, download. The signed token is the only key. */
@ApiTags('Public')
@Controller('public/sign')
export class PublicSigningController {
  constructor(private readonly paperwork: PaperworkService) {}

  @Public()
  @RateLimit({ name: 'public-sign', limit: 60, windowSeconds: 900 })
  @Get(':token')
  view(@Param('token') token: string) {
    return this.paperwork.publicView(token);
  }
  @Public()
  @RateLimit({ name: 'public-sign-submit', limit: 10, windowSeconds: 900 })
  @Post(':token')
  @HttpCode(200)
  sign(@Param('token') token: string, @Body() body: SignDto) {
    return this.paperwork.publicSign(token, body);
  }
  @Public()
  @RateLimit({ name: 'public-sign', limit: 60, windowSeconds: 900 })
  @Get(':token/pdf')
  @ApiProduces('application/pdf')
  async pdf(@Param('token') token: string, @Res() res: Response) {
    sendPdf(res, await this.paperwork.publicPdf(token));
  }
}
