import { Router } from 'express';
import { prisma } from '../../db/index.js';
import { apiLogger as logger } from '../../utils/logger.js';

const router = Router();

/**
 * Get current settings
 */
router.get('/', async (_req, res) => {
  try {
    const settings = await prisma.settings.findUnique({
      where: { id: 'default' },
    });
    res.json({ success: true, data: settings });
  } catch (error) {
    logger.error({ error }, 'Failed to get settings');
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

/**
 * Update settings
 */
router.patch('/', async (req, res) => {
  try {
    const updates = req.body;
    
    // Validate max leverage
    if (updates.maxLeverage !== undefined) {
      updates.maxLeverage = Math.min(updates.maxLeverage, 10);
    }
    
    const settings = await prisma.settings.update({
      where: { id: 'default' },
      data: updates,
    });
    
    res.json({ success: true, data: settings });
  } catch (error) {
    logger.error({ error }, 'Failed to update settings');
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

/**
 * Get symbol configs
 */
router.get('/symbols', async (_req, res) => {
  try {
    const symbols = await prisma.symbolConfig.findMany({
      orderBy: { symbol: 'asc' },
    });
    res.json({ success: true, data: symbols });
  } catch (error) {
    logger.error({ error }, 'Failed to get symbol configs');
    res.status(500).json({ success: false, error: 'Failed to fetch symbol configs' });
  }
});

/**
 * Create or update symbol config
 */
router.put('/symbols/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const config = req.body;
    
    const symbolConfig = await prisma.symbolConfig.upsert({
      where: { symbol },
      update: config,
      create: {
        symbol,
        ...config,
      },
    });
    
    res.json({ success: true, data: symbolConfig });
  } catch (error) {
    logger.error({ error }, 'Failed to update symbol config');
    res.status(500).json({ success: false, error: 'Failed to update symbol config' });
  }
});

/**
 * Delete symbol config
 */
router.delete('/symbols/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    
    await prisma.symbolConfig.delete({
      where: { symbol },
    });
    
    res.json({ success: true, message: `Deleted config for ${symbol}` });
  } catch (error) {
    logger.error({ error }, 'Failed to delete symbol config');
    res.status(500).json({ success: false, error: 'Failed to delete symbol config' });
  }
});

export default router;

