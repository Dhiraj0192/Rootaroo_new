import { Router } from 'express';
import { authenticate } from '../../shared/middleware/auth';
import { requireEntitlement } from '../billing/entitlement';
import { validate } from '../../shared/middleware/validate';
import * as ctrl from './controller';
import {
  createExpenseSchema,
  updateExpenseSchema,
  expenseQuerySchema,
  settlementSchema,
  markSettledSchema,
  remindSchema,
} from './validation';

const router = Router();

router.use(authenticate);
router.use(requireEntitlement);

// Expense CRUD
router.post('/', validate(createExpenseSchema), ctrl.createExpenseCtrl);           // FR-100
router.get('/', validate(expenseQuerySchema), ctrl.listExpensesCtrl);              // FR-106
router.get('/summary', ctrl.getExpenseSummaryCtrl);                                // FR-103/104/109
router.get('/ledger', ctrl.getLedgerCtrl);                                         // FR-104
router.get('/pairwise/:userId', ctrl.getPairwiseBalancesCtrl);
router.get('/settlements', validate(expenseQuerySchema), ctrl.listSettlementsCtrl); // FR-106
router.post('/settle', validate(settlementSchema), ctrl.recordSettlementCtrl);     // FR-105
router.get('/:id', ctrl.getExpenseByIdCtrl);
router.patch('/:id', validate(updateExpenseSchema), ctrl.updateExpenseCtrl);       // FR-107/108
router.delete('/:id', ctrl.deleteExpenseCtrl);                                     // FR-107/108
router.post('/:id/settle', validate(markSettledSchema), ctrl.markExpenseSettledCtrl); // FR-107/108
router.post('/:id/remind', validate(remindSchema), ctrl.sendExpenseReminderCtrl);

export default router;