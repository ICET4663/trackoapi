import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Marks a route as reachable without a bearer token. Everything else is protected by
// default via the global JwtAuthGuard - this is an explicit opt-out, not opt-in, so a
// newly added endpoint is authenticated unless someone deliberately marks it @Public().
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
