import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createPayrollRunSchema, payPayrollRunSchema, payrollSettingsSchema, staffPaySchema, updatePayrollLineSchema } from '@typease/validation';
import { Permissions } from '../../common/auth/access';
import { can } from '../../common/context';
import { dto } from '../../common/zod';
import { PayrollService } from './payroll.service';

class StaffPayDto extends dto(staffPaySchema) {}
class CreateRunDto extends dto(createPayrollRunSchema) {}
class UpdateLineDto extends dto(updatePayrollLineSchema) {}
class PayRunDto extends dto(payPayrollRunSchema) {}
class SettingsDto extends dto(payrollSettingsSchema) {}

const send = (res: Response, file: { filename: string; content: Buffer | string }, type: string) => {
  res.status(200);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(file.content);
};

@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Permissions('payroll.manage')
  @Get('settings')
  settings() {
    return this.payroll.settings();
  }
  @Permissions('payroll.manage')
  @Put('settings')
  updateSettings(@Body() body: SettingsDto) {
    return this.payroll.updateSettings(body);
  }
  @Permissions('payroll.manage')
  @Get('staff')
  staff() {
    return this.payroll.staff();
  }
  @Permissions('payroll.manage')
  @Put('staff/:membershipId')
  @ApiOperation({ summary: 'Salary, allowances and WPS details of one staff member (the IBAN is stored encrypted)' })
  setPay(@Param('membershipId', ParseUUIDPipe) id: string, @Body() body: StaffPayDto) {
    return this.payroll.setPay(id, body);
  }
  @Permissions('payroll.manage')
  @Get('runs')
  runs() {
    return this.payroll.runs();
  }
  @Permissions('payroll.manage')
  @Post('runs')
  @ApiOperation({ summary: 'Draft the payroll of a month (salaries pro rata, unpaid commission included)' })
  create(@Body() body: CreateRunDto) {
    return this.payroll.create(body.period, body.notes);
  }
  @Permissions('payroll.manage')
  @Get('runs/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.get(id);
  }
  @Permissions('payroll.manage')
  @Delete('runs/:id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.remove(id);
  }
  @Permissions('payroll.manage')
  @Patch('runs/:id/lines/:lineId')
  updateLine(@Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string, @Body() body: UpdateLineDto) {
    return this.payroll.updateLine(id, lineId, body);
  }
  @Permissions('payroll.manage')
  @Post('runs/:id/approve')
  @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.payroll.approve(id);
  }
  @Permissions('payroll.manage')
  @Post('runs/:id/pay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record that the salaries were paid: commission marked paid, salaries posted to the books' })
  pay(@Param('id', ParseUUIDPipe) id: string, @Body() body: PayRunDto) {
    return this.payroll.pay(id, body.paidFrom, body.reference);
  }
  @Permissions('payroll.manage')
  @Get('runs/:id/wps')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'WPS Salary Information File (SIF) of an approved payroll' })
  async wps(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    send(res, await this.payroll.sif(id), 'text/plain; charset=utf-8');
  }
  @Permissions('payroll.manage', 'payroll.view_own')
  @Get('payslips/mine')
  mine() {
    return this.payroll.myPayslips();
  }
  @Permissions('payroll.manage', 'payroll.view_own')
  @Get('payslips/:lineId/pdf')
  @ApiProduces('application/pdf')
  async payslip(@Param('lineId', ParseUUIDPipe) lineId: string, @Res() res: Response) {
    send(res, await this.payroll.payslip(lineId, can('payroll.manage')), 'application/pdf');
  }
}
