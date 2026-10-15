import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ocrApplySchema, ocrExtractSchema, ocrResultsQuery, ocrReviewSchema, ocrUsageQuery } from '@typease/validation';
import { Permissions } from '../../common/auth/access';
import { dto } from '../../common/zod';
import { OcrService } from './ocr.service';

class ExtractDto extends dto(ocrExtractSchema) {}
class ReviewDto extends dto(ocrReviewSchema) {}
class ApplyDto extends dto(ocrApplySchema) {}
class ResultsQueryDto extends dto(ocrResultsQuery) {}
class UsageQueryDto extends dto(ocrUsageQuery) {}

@ApiTags('AI document assistant')
@ApiBearerAuth()
@Controller()
export class OcrController {
  constructor(private readonly ocr: OcrService) {}

  @Permissions('ocr.run')
  @Post('documents/:id/extract')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue OCR + field extraction for a document. The result is a suggestion that needs human review' })
  extract(@Param('id', ParseUUIDPipe) id: string, @Body() body: ExtractDto) {
    return this.ocr.requestExtraction(id, body);
  }

  @Permissions('ocr.run', 'ocr.review')
  @Get('documents/:id/extractions')
  extractions(@Param('id', ParseUUIDPipe) id: string) {
    return this.ocr.listForDocument(id);
  }

  @Permissions('ocr.run', 'ocr.review')
  @Get('ocr/results')
  @ApiOperation({ summary: 'Extraction results, e.g. ?status=COMPLETED for the review queue' })
  list(@Query() query: ResultsQueryDto) {
    return this.ocr.list(query);
  }

  @Permissions('ocr.review', 'settings.manage', 'report.operational')
  @Get('ocr/usage')
  @ApiOperation({ summary: 'AI usage and estimated cost for the centre' })
  usage(@Query() query: UsageQueryDto) {
    return this.ocr.usageReport(query);
  }

  @Permissions('ocr.run', 'ocr.review')
  @Get('ocr/results/:id')
  @ApiOperation({ summary: 'Review screen data: extracted values next to what is on file (masked), with confidence and warnings' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.ocr.get(id);
  }

  @Permissions('ocr.review')
  @Post('ocr/results/:id/review')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record the values a person confirmed or corrected' })
  review(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDto) {
    return this.ocr.review(id, body);
  }

  @Permissions('ocr.review')
  @Post('ocr/results/:id/apply')
  @HttpCode(200)
  @ApiOperation({ summary: 'Copy selected reviewed values to the customer profile / document (REVIEWED results only)' })
  apply(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApplyDto) {
    return this.ocr.apply(id, body);
  }
}
