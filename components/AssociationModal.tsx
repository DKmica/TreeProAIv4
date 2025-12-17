import React, { useState } from 'react';
import { clientService, propertyService } from '../services/apiService';

interface AssociationModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultName?: string;
  onCreated: (ids: { clientId: string; propertyId: string }) => void;
}

const AssociationModal: React.FC<AssociationModalProps> = ({ isOpen, onClose, defaultName, onCreated }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    if (defaultName) {
      const parts = defaultName.split(' ');
      setFirstName(parts[0] || '');
      setLastName(parts.slice(1).join(' '));
    }
  }, [defaultName]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setError(null);
    if (!firstName.trim() || !lastName.trim() || !email.trim() || !phone.trim() || !addressLine1.trim() || !city.trim() || !state.trim() || !zipCode.trim()) {
      setError('All fields are required to create linked records.');
      return;
    }

    setIsSaving(true);
    try {
      const client = await clientService.create({
        firstName,
        lastName,
        primaryEmail: email,
        primaryPhone: phone,
      });

      const property = await propertyService.createForClient(client.id, {
        addressLine1,
        city,
        state,
        zipCode,
      });

      onCreated({ clientId: client.id, propertyId: property.id });
      onClose();
    } catch (err: any) {
      console.error('Failed to create association', err);
      setError(err.message || 'Unable to save linked records');
    } finally {
      setIsSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
      onClick={handleOverlayClick}
    >
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Quick-create client & property</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">×</button>
        </div>

        <div className="px-6 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-md text-sm">{error}</div>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First name</label>
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className="w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last name</label>
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} className="w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Property address</label>
            <input value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} className="w-full rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500" placeholder="Street address" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" className="rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500" />
            <input value={state} onChange={(e) => setState(e.target.value)} placeholder="State" className="rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500" />
            <input value={zipCode} onChange={(e) => setZipCode(e.target.value)} placeholder="ZIP" className="rounded-md border-gray-300 shadow-sm focus:border-cyan-500 focus:ring-cyan-500" />
          </div>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 rounded-md border border-gray-300 text-gray-700 hover:bg-white" disabled={isSaving}>Cancel</button>
          <button onClick={handleSave} disabled={isSaving} className="px-4 py-2 rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 flex items-center gap-2">
            {isSaving && <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>}
            Save & link
          </button>
        </div>
      </div>
    </div>
  );
};

export default AssociationModal;