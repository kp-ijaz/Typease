import { pushPayload } from './push-payload';

describe('push payload (deep-link data fields)', () => {
  const row = { id: 'n-1', eventKey: 'request.completed', relatedType: 'ServiceRequest', relatedId: '7b1c2f0e-0000-4000-8000-000000000001', data: {} as Record<string, any> };

  it('carries relatedType and relatedId of the notification record, the event and the notification id', () => {
    expect(pushPayload(row)).toEqual({ eventKey: 'request.completed', relatedType: 'ServiceRequest', relatedId: row.relatedId, notificationId: 'n-1' });
  });

  it('takes the target from the record even when the stored rendering has no copy, or a different one', () => {
    expect(pushPayload({ ...row, data: null })).toMatchObject({ relatedType: 'ServiceRequest', relatedId: row.relatedId });
    expect(pushPayload({ ...row, data: { push: { relatedType: 'Invoice', relatedId: 'stale', eventKey: 'old.key', screen: 'timeline' } } })).toEqual({
      eventKey: 'request.completed', relatedType: 'ServiceRequest', relatedId: row.relatedId, screen: 'timeline', notificationId: 'n-1',
    });
  });

  it('leaves the target out when the record has none, and only ever sends strings', () => {
    const none = pushPayload({ ...row, relatedType: null, relatedId: null, data: { push: { relatedType: 'Invoice', relatedId: 'x', badge: 3, flag: true, empty: null } } });
    expect(none).toEqual({ eventKey: 'request.completed', badge: '3', flag: 'true', notificationId: 'n-1' });
    for (const value of Object.values(pushPayload(row))) expect(typeof value).toBe('string');
  });
});
