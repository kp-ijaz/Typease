import 'reflect-metadata';
import { startServer } from './bootstrap';

startServer().catch((e) => {
  // Configuration and start-up errors must be loud and fatal.
  console.error(e);
  process.exit(1);
});
