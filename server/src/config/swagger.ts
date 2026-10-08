import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Rootaroo API',
      version: '1.0.0',
      description: 'Family-first mobile application backend',
    },
    servers: [
      { url: '/api/v1', description: 'API v1' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
        billingAdminKey: { type: 'apiKey', in: 'header', name: 'x-admin-billing-key' },
        adminApiKey: { type: 'apiKey', in: 'header', name: 'x-admin-api-key' },
      },
    },
  },
  apis: ['./src/modules/**/routes.ts', './src/modules/billing/admin/routes.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
