// تمرير صورة بين الشات والاستوديو داخل نفس الصفحة (من غير تخزين، علشان الصور ممكن تكون كبيرة)
let toStudio = null; // { url, name, returnTo, cid }
let toChat = null; // { hash, cid, attachment }

export const sendToStudio = (item) => { toStudio = item; window.location.hash = "#/studio"; };
export const takeForStudio = () => { const x = toStudio; toStudio = null; return x; };

export const sendToChat = (hash, cid, attachment) => { toChat = { hash, cid, attachment }; window.location.hash = hash; };
export const takeForChat = (hash) => {
  if (!toChat || toChat.hash !== hash) return null;
  const x = toChat; toChat = null; return x;
};
