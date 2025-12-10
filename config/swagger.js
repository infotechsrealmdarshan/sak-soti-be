import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'SAK SOTI Backend API',
      version: '1.0.0',
      description: 'A comprehensive backend API for SAK SOTI platform with user management, posts, news, and admin functionality',
      contact: {
        name: 'API Support',
        email: 'support@saksoti.com'
      }
    },
    // servers: [
    //   {
    //     url: 'http://localhost:3001',
    //     description: 'Development server'
    //   }
    // ],
    tags: [
      {
        name: 'Users',
        description: 'User management endpoints'
      },
      {
        name: 'Admin',
        description: 'Admin management endpoints'
      },
      {
        name: 'News',
        description: 'News management endpoints'
      },
      {
        name: 'Posts',
        description: 'Post management endpoints'
      },
      {
        name: 'Chat',
        description: 'Individual chat & group chat requests and messaging'
      },
      {
        name: 'Transaction',
        description: 'Subscription and transaction management endpoints'
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      },
      schemas: {
        User: {
          type: 'object',
          required: ['firstname', 'lastname', 'email', 'password'],
          properties: {
            _id: {
              type: 'string',
              description: 'Unique identifier for the user',
              example: '6900581abc67d4e7b7fe91cf'
            },
            firstname: {
              type: 'string',
              description: 'User first name',
              example: 'John'
            },
            lastname: {
              type: 'string',
              description: 'User last name',
              example: 'Doe'
            },
            email: {
              type: 'string',
              format: 'email',
              description: 'User email address',
              example: 'john.doe@example.com'
            },
            profileimg: {
              type: 'string',
              description: 'Profile image URL',
              example: '/uploads/profile123.jpg'
            },
            status: {
              type: 'string',
              enum: ['active', 'inactive'],
              description: 'User account status',
              example: 'active'
            },
            isAdmin: {
              type: 'boolean',
              description: 'Whether user has admin privileges',
              example: false
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'User creation timestamp'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'User last update timestamp'
            }
          }
        },
        Post: {
          type: 'object',
          required: ['title', 'description', 'mediaType', 'mediaUrl'],
          properties: {
            _id: {
              type: 'string',
              description: 'Unique identifier for the post',
              example: '6900581abc67d4e7b7fe91cf'
            },
            title: {
              type: 'string',
              description: 'Post title',
              example: 'Amazing Sunset View'
            },
            description: {
              type: 'string',
              description: 'Post description',
              example: 'Beautiful sunset captured at the beach'
            },
            mediaType: {
              type: 'string',
              enum: ['image', 'video'],
              description: 'Type of media attached',
              example: 'image'
            },
            mediaUrl: {
              type: 'string',
              description: 'URL of the attached media',
              example: '/uploads/post123.jpg'
            },
            author: {
              type: 'string',
              description: 'ID of the user who created the post',
              example: '6900581abc67d4e7b7fe91cf'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'Post creation timestamp'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Post last update timestamp'
            }
          }
        },
        News: {
          type: 'object',
          required: ['title', 'description', 'mediaType', 'mediaUrl'],
          properties: {
            _id: {
              type: 'string',
              description: 'Unique identifier for the news',
              example: '6900581abc67d4e7b7fe91cf'
            },
            title: {
              type: 'string',
              description: 'News title',
              example: 'Breaking: New Technology Launch'
            },
            description: {
              type: 'string',
              description: 'News description',
              example: 'Revolutionary new technology announced today'
            },
            mediaType: {
              type: 'string',
              enum: ['image', 'video'],
              description: 'Type of media attached',
              example: 'image'
            },
            mediaUrl: {
              type: 'string',
              description: 'URL of the attached media',
              example: '/uploads/news123.jpg'
            },
            author: {
              type: 'string',
              description: 'ID of the admin who created the news',
              example: '6900581abc67d4e7b7fe91cf'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'News creation timestamp'
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'News last update timestamp'
            }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Error message',
              example: 'User not found'
            },
            message: {
              type: 'string',
              description: 'Detailed error message',
              example: 'The requested user does not exist'
            }
          }
        },
        Success: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Success message',
              example: 'Operation completed successfully'
            },
            data: {
              type: 'object',
              description: 'Response data'
            }
          }
        }
      }
    },
    // security: [
    //   {
    //     bearerAuth: []
    //   }
    // ]
  },
  apis: ['./routes/*.js']
};

const specs = swaggerJsdoc(options);

export { specs, swaggerUi };
