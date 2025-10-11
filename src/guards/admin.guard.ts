import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = req.headers['x-admin-token'];
    const expected = this.configService.get<string>('ADMIN_TOKEN');
    if (!expected || header !== expected) {
      throw new UnauthorizedException('Admin token invalid');
    }
    return true;
  }
}
